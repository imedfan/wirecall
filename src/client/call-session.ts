import { profileFor, START_TIER, TIER_ORDER, type QualityTier, type TierProfile } from "../shared/adaptive";
import { RetryBudget } from "../shared/backoff";
import { sanitizeIceServers, type IceServer } from "../shared/ice-servers";
import { isPeerId, PROTOCOL_VERSION, type KeptLink } from "../shared/protocol";
import { tierName } from "../shared/quality-label";
import { redactLogFields } from "../shared/redact";
import { isResumeToken } from "../shared/ids";
import { GROUP_CAPACITY, PAIR_CAPACITY } from "../shared/room-state";
import type { StatSummary } from "../shared/stats";
import { audioConstraints, type FacingMode, openCallMedia, videoConstraints } from "./open-media";
import { applyMediaIntent, freshMediaIntent, toggleMediaIntent, type MediaIntent, type VideoTrackControl } from "./media-intent";
import { PeerLink, type LinkHost, type LinkPhase, type TurnMode } from "./peer-link";

export type CallPhase = "idle" | "starting" | "waiting" | "connecting" | "live" | "trouble" | "ended";

/** One other person as the screen needs them: a picture, and how the connection to them is doing. */
export interface RemotePeer {
  id: string;
  stream: MediaStream | null;
  phase: LinkPhase;
  note: string;
  /** Their own outgoing link, when they reported it. */
  tier: QualityTier | null;
}

export interface CallHooks {
  onStatus: (text: string) => void;
  /** The few lines a person may want at a glance, then everything else. */
  onDiagnostics: (main: string[], more: string[]) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onMediaIssue: (reason: "denied" | "missing" | "busy" | "failed" | null) => void;
  /** canRejoin is false when joining this room again cannot work, as with a link that has expired. */
  onEnded: (text: string, canRejoin: boolean) => void;
  onWaiting: (waiting: boolean) => void;
  onPhase?: (phase: CallPhase) => void;
  /** This side's own outgoing leg, and the other person's when they report it over the data channel. */
  onQuality?: (tier: QualityTier, peerTier: QualityTier | null) => void;
  onCameras?: (count: number) => void;
  /** Everyone else in the call, in the order they are shown. Called whenever one of them changes. */
  onPeers?: (peers: RemotePeer[]) => void;
  /** A picture or a voice arrived, or the page came back: whatever is on screen should be playing. */
  onPlayback?: () => void;
  /** How many people the room holds, as the room itself says. */
  onCapacity?: (capacity: number) => void;
}

interface WelcomePeer {
  peerId: string;
  gen: number;
  polite: boolean;
  online: boolean;
}

interface WelcomeMessage {
  type: "welcome";
  peerId: string;
  capacity?: number;
  resumed: boolean;
  turnMode: TurnMode;
  iceServers: IceServer[];
  resumeToken?: string;
  expiresAt: number;
  peers?: unknown;
}

const NO_RETRY = new Set([1000, 1008, 4000, 4002, 4004]);
const PING_EVERY_MS = 20_000;
const PONG_DEADLINE_MS = 10_000;
const PROBE_DEADLINE_MS = 4_000;
export class CallSession {
  private socket: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  /** One connection per other person, in the order they appeared. */
  private links = new Map<string, PeerLink>();
  private capacity: number;
  private shownPhase: CallPhase = "idle";
  private shownStatus = "";
  // About five minutes of attempts: long enough for a tunnel or a Wi-Fi to cellular handover.
  private signalRetry = new RetryBudget(40, 500, 8_000);
  private socketReady = false;
  private pongTimer = 0;
  private networkChangedAt = 0;
  private switching = false;
  private restoring = false;
  private closed = false;
  private facing: FacingMode = "user";
  private statsTimer = 0;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private turnMode: TurnMode = "off";
  private started = false;
  private epoch = 0;
  private intent: MediaIntent = freshMediaIntent();
  private heldVideo: VideoTrackControl | null = null;
  private savedIce: IceServer[] = [];
  private listening = false;
  private previewJob: Promise<boolean> | null = null;
  private networkTarget: EventTarget | null = null;
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.onForeground();
  };
  private readonly onOnline = (): void => {
    this.onNetworkChange();
  };
  private readonly onNetwork = (): void => {
    this.onNetworkChange();
  };
  private readonly onPageHide = (): void => {
    // Closing or reloading the tab frees the seat at once instead of holding it until the stale sweep.
    if (this.started && !this.closed) this.finish("Звонок завершён", true);
  };

  private readonly host: LinkHost = {
    epoch: () => this.epoch,
    alive: (epoch) => this.isCurrent(epoch),
    socketReady: () => this.socketReady,
    send: (message) => this.send(message),
    reconnectSocket: () => this.reconnectSocket(),
    localStream: () => this.localStream,
    intent: () => this.intent,
    turnMode: () => this.turnMode,
    networkChangedAt: () => this.networkChangedAt,
    profile: (tier) => this.profile(tier),
    linkStatus: (link, text) => this.onLinkStatus(link, text),
    linkPhase: (link) => this.onLinkPhase(link),
    linkMedia: () => {
      this.publishPeers();
      this.hooks.onPlayback?.();
    },
    linkQuality: () => {
      this.publishQuality();
      this.publishPeers();
    },
  };

  /** `group` is what the link says about the room. The room's own word arrives with the welcome. */
  constructor(
    private readonly roomId: string,
    private readonly localVideo: HTMLVideoElement,
    private readonly hooks: CallHooks,
    group = false,
  ) {
    this.capacity = group ? GROUP_CAPACITY : PAIR_CAPACITY;
    this.localVideo.playsInline = true;
    this.localVideo.autoplay = true;
    this.localVideo.muted = true;
  }

  /**
   * Opens the camera and the microphone for the lobby, before the call. Nothing is sent anywhere.
   * start() takes the same stream over, so the camera is not opened twice. Resolves to true when there is a picture.
   */
  preview(): Promise<boolean> {
    if (this.started || this.closed || this.localStream) return Promise.resolve(false);
    this.previewJob ??= (async () => {
      const media = await this.openMedia();
      this.previewJob = null;
      if (!media.ok) return false;
      // A call that ended while the camera was opening must not leave it on.
      if (this.closed || this.localStream) {
        media.stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      this.adoptLocal(media.stream);
      return media.video;
    })();
    return this.previewJob;
  }

  async start(): Promise<void> {
    if (this.started && !this.closed) return;
    this.epoch += 1;
    const epoch = this.epoch;
    this.started = true;
    this.closed = false;
    this.signalRetry.reset();
    this.setPhase("starting");
    this.setStatus("Включаем камеру и микрофон");
    // A lobby preview that is still opening is waited for, not raced with a second request for the camera.
    if (this.previewJob) await this.previewJob.catch(() => false);
    if (!this.isCurrent(epoch)) return;
    const kept = this.localStream;
    if (kept && kept.getTracks().length > 0 && kept.getTracks().every((track) => track.readyState === "live")) {
      this.hooks.onMediaIssue(null);
      void this.reportCameras();
    } else {
      this.stopMedia();
      const media = await this.openMedia();
      if (!this.isCurrent(epoch)) {
        if (media.ok) media.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!media.ok) {
        this.started = false;
        this.hooks.onMediaIssue(media.reason);
        this.setStatus(mediaIssueText(media.reason));
        this.setPhase("idle");
        return;
      }
      this.hooks.onMediaIssue(null);
      this.adoptLocal(media.stream);
      void this.reportCameras();
      if (!media.video) this.setStatus("Камера недоступна. Звонок со звуком.");
    }
    this.attachLifecycle();
    await this.requestWake(epoch);
    if (!this.isCurrent(epoch)) return;
    this.connectSocket();
  }

  hangup(): void {
    this.finish("Звонок завершён", true);
  }

  private openMedia(): ReturnType<typeof openCallMedia> {
    return openCallMedia({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      supported: (navigator.mediaDevices.getSupportedConstraints?.() ?? null) as Record<string, boolean> | null,
      facingMode: this.facing,
    });
  }

  /** Makes a freshly opened stream the local one: the person's mute choices, the self view, the track watchers. */
  private adoptLocal(stream: MediaStream): void {
    this.localStream = stream;
    for (const track of stream.getTracks()) {
      applyMediaIntent(track, this.intent);
      this.watchTrack(track);
    }
    this.heldVideo = stream.getVideoTracks()[0] ?? null;
    this.localVideo.srcObject = stream;
    this.markFacing(stream.getVideoTracks()[0]);
    void this.localVideo.play().catch(() => undefined);
  }

  toggleAudio(): boolean {
    const enabled = toggleMediaIntent(this.intent, "audio");
    const track = this.localStream?.getAudioTracks()[0];
    if (track) applyMediaIntent(track, this.intent);
    return enabled;
  }

  toggleVideo(): boolean {
    const enabled = toggleMediaIntent(this.intent, "video");
    const track = this.heldVideo ?? this.localStream?.getVideoTracks()[0] ?? null;
    if (track) applyMediaIntent(track, this.intent);
    return enabled;
  }

  /** Starts new connections to everyone who is not heard and seen. For the «Переподключить» button. */
  retry(): void {
    if (!this.isCurrent(this.epoch)) return;
    this.signalRetry.reset();
    this.setPhase("connecting");
    this.setStatus("Соединяем заново");
    let asked = this.links.size > 0;
    for (const link of this.links.values()) {
      if (!link.up() && !link.retry()) asked = false;
    }
    // Without a socket, or without the other person's, the room has to be joined again first.
    if (!asked) this.reconnectSocket();
  }

  async switchCamera(): Promise<void> {
    const stream = this.localStream;
    if (!this.isCurrent(this.epoch) || !stream || this.switching) return;
    const epoch = this.epoch;
    this.switching = true;
    try {
      const previous = stream.getVideoTracks()[0];
      const target = await this.nextCamera(previous);
      if (!this.isCurrent(epoch) || this.localStream !== stream) return;
      // iPhone and many Android phones cannot open a second camera while the first is live.
      previous?.stop();
      let next = await this.openCamera(target);
      let switched = next !== null;
      if (!next) next = await this.openCamera({ facing: this.facing });
      if (!this.isCurrent(epoch) || this.localStream !== stream) {
        next?.stop();
        return;
      }
      if (!next) {
        this.hooks.onStatus("Не удалось переключить камеру");
        return;
      }
      if (switched && target.facing) this.facing = target.facing;
      if (!switched) this.hooks.onStatus("Не удалось переключить камеру");
      switched = true;
      applyMediaIntent(next, this.intent);
      this.watchTrack(next);
      if (previous) stream.removeTrack(previous);
      stream.addTrack(next);
      this.heldVideo = next;
      this.localVideo.srcObject = stream;
      this.markFacing(next);
      void this.localVideo.play().catch(() => undefined);
      for (const link of this.links.values()) await link.swapTrack(previous, next, stream);
      if (!this.isCurrent(epoch)) return;
      await this.applyTiers(epoch);
    } catch {
      if (this.isCurrent(epoch)) this.hooks.onStatus("Не удалось переключить камеру");
    } finally {
      this.switching = false;
    }
  }

  private connectSocket(): void {
    if (this.closed) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    this.socketReady = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${this.roomId}/socket`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.closed || this.socket !== socket) {
        socket.close(1000, "hangup");
        return;
      }
      const resume = readToken(this.resumeKey());
      const hello: { type: "hello"; protocol: number; resume?: string; keep?: KeptLink[] } = { type: "hello", protocol: PROTOCOL_VERSION };
      if (resume && isResumeToken(resume)) hello.resume = resume;
      // Naming the generations tells the room which media connections this side still holds and wants to keep.
      const keep = [...this.links.values()].filter((link) => link.hasConnection()).map((link) => ({ peerId: link.peerId, gen: link.gen }));
      if (keep.length > 0) hello.keep = keep;
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      if (this.closed || this.socket !== socket || typeof event.data !== "string") return;
      void this.onServerMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      this.socketReady = false;
      window.clearTimeout(this.pongTimer);
      this.pongTimer = 0;
      if (NO_RETRY.has(event.code)) {
        this.finish(closeText(event.code, event.reason, this.capacity), false, event.code !== 4004 && event.reason !== "expired");
        return;
      }
      const delay = this.signalRetry.next();
      if (delay === null) {
        this.finish("Связь не восстановилась. Попробуйте войти снова.", false);
        return;
      }
      const epoch = this.epoch;
      // Sound and picture go browser to browser. They survive a signaling drop until the room rebuilds the call.
      if (!this.anyUp()) {
        this.setPhase("trouble");
        this.setStatus("Связь с комнатой прервалась. Пробуем снова.");
      }
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = 0;
        if (!this.isCurrent(epoch)) return;
        this.connectSocket();
      }, delay);
    });
  }

  /** Drops the current socket and joins again with the resume token. The media connection stays as it is. */
  private reconnectSocket(): void {
    if (this.closed || !this.started) return;
    const previous = this.socket;
    this.socket = null;
    this.socketReady = false;
    window.clearTimeout(this.pongTimer);
    this.pongTimer = 0;
    try {
      previous?.close(4001, "resync");
    } catch {
      // A socket that is already closing needs nothing.
    }
    this.connectSocket();
  }

  private ping(deadlineMs: number): void {
    const socket = this.socket;
    // The server closes a socket that speaks before its welcome.
    if (!socket || !this.socketReady || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "ping" }));
    window.clearTimeout(this.pongTimer);
    const epoch = this.epoch;
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = 0;
      // A phone that changed networks keeps a dead socket open for minutes. No pong means it is gone.
      if (!this.isCurrent(epoch) || this.socket !== socket) return;
      this.reconnectSocket();
    }, deadlineMs);
  }

  private async onServerMessage(raw: string): Promise<void> {
    if (this.closed) return;
    const epoch = this.epoch;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "welcome") {
      await this.onWelcome(message as unknown as WelcomeMessage, epoch);
      return;
    }
    if (message.type === "pong") {
      window.clearTimeout(this.pongTimer);
      this.pongTimer = 0;
      return;
    }
    const peerId = isPeerId(message.peerId) ? message.peerId : isPeerId(message.from) ? message.from : null;
    if (!peerId) return;
    if (message.type === "peer-left") {
      const link = this.links.get(peerId);
      if (!link) return;
      link.online = false;
      if (message.gone === false) {
        // Only that person's signaling is away. Sound and picture go directly and may be perfectly fine.
        link.pauseRecovery();
        if (link.hasConnection() && !link.up()) link.setStatus("У собеседника пропала связь. Ждём его возвращения.");
        return;
      }
      this.removeLink(link);
      if (this.links.size > 0) return;
      this.announceWaiting();
      this.setStatus(this.capacity > PAIR_CAPACITY ? "Все вышли. Ждём возвращения." : "Собеседник вышел. Ждём возвращения.");
      this.setPhase("waiting");
      return;
    }
    if (message.type === "peer-joined" || message.type === "peer-back" || message.type === "rebuild") {
      const gen = generationOf(message.gen);
      if (gen === null) return;
      // A rebuild is about a connection that exists. Only a peer the room announces gets a new one.
      const link = message.type === "rebuild" ? this.links.get(peerId) : this.linkTo(peerId, message.polite === true);
      if (!link) return;
      if (message.type !== "rebuild") {
        link.polite = message.polite === true;
        link.online = true;
      }
      this.adoptIce(message);
      if (link.holds(gen)) {
        // Same generation: the other side kept its connection and so does this one.
        link.resume();
        return;
      }
      await this.connect(link, gen, message.type === "peer-joined" ? "Соединяем" : "Соединяем заново");
      return;
    }
    const link = this.links.get(peerId);
    if (!link) return;
    if (message.type === "restart") {
      const gen = generationOf(message.gen);
      if (gen !== null) link.onRestart(gen, message.ack === true);
      return;
    }
    if (message.type === "signal" && typeof message.payload === "string" && (message.kind === "offer" || message.kind === "answer" || message.kind === "ice")) {
      const gen = generationOf(message.gen);
      if (gen !== null) await link.onSignal(message.kind, message.payload, gen);
    }
  }

  private adoptIce(message: Record<string, unknown>): void {
    const servers = sanitizeIceServers(message.iceServers);
    if (servers.length > 0) this.savedIce = servers;
    if (message.turnMode === "on" || message.turnMode === "off" || message.turnMode === "error") this.turnMode = message.turnMode;
  }

  private async onWelcome(welcome: WelcomeMessage, epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    this.signalRetry.reset();
    this.socketReady = true;
    this.turnMode = welcome.turnMode;
    this.savedIce = welcome.iceServers;
    if (welcome.resumeToken && isResumeToken(welcome.resumeToken)) writeToken(this.resumeKey(), welcome.resumeToken);
    if (typeof welcome.capacity === "number" && welcome.capacity >= PAIR_CAPACITY) {
      this.capacity = welcome.capacity;
      this.hooks.onCapacity?.(welcome.capacity);
    }
    const peers = welcomePeers(welcome.peers);
    // Whoever the room no longer lists left while this side was away.
    for (const link of [...this.links.values()]) {
      if (!peers.some((peer) => peer.peerId === link.peerId)) this.removeLink(link);
    }
    if (peers.length === 0) {
      // Alone in the room. A connection is built when someone arrives, with fresh ICE servers.
      this.announceWaiting();
      this.setPhase("waiting");
    } else {
      await Promise.all(
        peers.map(async (peer) => {
          const link = this.linkTo(peer.peerId, peer.polite);
          link.polite = peer.polite;
          link.online = peer.online;
          // Only the signaling socket was replaced. The media connection of this generation goes on untouched.
          if (link.holds(peer.gen)) link.resume();
          else await this.connect(link, peer.gen, "Соединяем");
        }),
      );
    }
    if (!this.isCurrent(epoch)) return;
    this.publishDiagnostics();
    this.startStats();
  }

  /** Builds the connection of this generation to one person and starts agreeing on it. */
  private async connect(link: PeerLink, gen: number, text: string): Promise<void> {
    link.build(gen, this.savedIce);
    link.setStatus(text);
    link.setPhase("connecting");
    await link.negotiate();
  }

  private linkTo(peerId: string, polite: boolean): PeerLink {
    const known = this.links.get(peerId);
    if (known) return known;
    const link = new PeerLink(peerId, polite, this.host);
    this.links.set(peerId, link);
    // One more person to send to: every outgoing video gets a smaller share of the uplink.
    void this.applyTiers(this.epoch);
    return link;
  }

  private removeLink(link: PeerLink): void {
    link.close();
    this.links.delete(link.peerId);
    this.publishPeers();
    const [only, ...rest] = [...this.links.values()];
    if (only && rest.length === 0) {
      // Back to two people: the screen says what that one connection says.
      this.setStatus(only.note);
      this.setPhase(only.phase);
    } else if (only) {
      this.syncGroup();
    }
    void this.applyTiers(this.epoch);
    this.publishQuality();
  }

  private onLinkStatus(link: PeerLink, text: string): void {
    if (this.links.size <= 1) this.setStatus(text);
    else this.syncGroup();
    if (this.links.has(link.peerId)) this.publishPeers();
  }

  private onLinkPhase(link: PeerLink): void {
    if (this.links.size <= 1) this.setPhase(link.phase);
    else this.syncGroup();
    if (this.links.has(link.peerId)) this.publishPeers();
  }

  /**
   * With several people the screen follows the call as a whole: it is live while anyone is heard, and
   * each person's own trouble is shown on their picture. Only a real change reaches the screen.
   */
  private syncGroup(): void {
    const links = [...this.links.values()];
    const phase: LinkPhase = links.some((link) => link.phase === "live") ? "live" : links.some((link) => link.phase === "trouble") ? "trouble" : "connecting";
    const text = phase === "live" ? "" : (links.find((link) => link.phase === phase)?.note ?? "");
    if (text !== this.shownStatus) this.setStatus(text);
    if (phase !== this.shownPhase) this.setPhase(phase);
  }

  /** Alone in the room. The screen words this itself, for two people or for a conference. */
  private announceWaiting(): void {
    this.shownStatus = "waiting";
    this.hooks.onWaiting(true);
  }

  private setStatus(text: string): void {
    this.shownStatus = text;
    this.hooks.onStatus(text);
  }

  private setPhase(phase: CallPhase): void {
    this.shownPhase = phase;
    this.hooks.onPhase?.(phase);
  }

  private publishPeers(): void {
    this.hooks.onPeers?.(
      [...this.links.values()].map((link) => ({ id: link.peerId, stream: link.remoteStream, phase: link.phase, note: link.note, tier: link.peerTier })),
    );
  }

  private anyUp(): boolean {
    return [...this.links.values()].some((link) => link.up());
  }

  /** The limits of a tier in this call: lower when the uplink is shared between several people. */
  private profile(tier: QualityTier): TierProfile {
    return profileFor(tier, this.links.size);
  }

  private async applyTiers(epoch: number): Promise<void> {
    await Promise.all([...this.links.values()].map((link) => link.applyTier(epoch)));
  }

  /** The weakest of this side's outgoing links, and the other person's own when there is exactly one. */
  private publishQuality(): void {
    const links = [...this.links.values()];
    const only = links.length === 1 ? links[0] : undefined;
    this.hooks.onQuality?.(worstTier(links.map((link) => link.quality.current())) ?? START_TIER, only?.peerTier ?? null);
  }

  private onNetworkChange(): void {
    if (!this.isCurrent(this.epoch)) return;
    this.networkChangedAt = Date.now();
    if (!this.socket && this.reconnectTimer) {
      // Waiting out a backoff makes no sense once the network is back.
      this.signalRetry.reset();
      this.connectSocket();
    } else {
      this.ping(PROBE_DEADLINE_MS);
    }
    for (const link of this.links.values()) link.networkChanged();
  }

  private send(message: object): void {
    // Before the welcome the server treats any message except hello as a protocol error and ends the call.
    if (!this.socketReady || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = window.setInterval(() => void this.sampleStats(), 2000);
    this.pingTimer = window.setInterval(() => this.ping(PONG_DEADLINE_MS), PING_EVERY_MS);
  }

  private async sampleStats(): Promise<void> {
    const epoch = this.epoch;
    if (!this.isCurrent(epoch) || this.links.size === 0) return;
    await Promise.all([...this.links.values()].map((link) => link.sample()));
    if (!this.isCurrent(epoch)) return;
    this.publishQuality();
    this.publishPeers();
    this.publishDiagnostics();
  }

  /** The numbers of one connection. With several people it is the one that is doing worst. */
  private publishDiagnostics(): void {
    const links = [...this.links.values()];
    const worst = worstTier(links.map((item) => item.quality.current()));
    const link = links.find((item) => item.quality.current() === worst);
    const summary: StatSummary | undefined = link?.summary;
    const tier = link?.quality.current() ?? START_TIER;
    const score = link?.quality.score() ?? null;
    const tierVia = link?.tierVia ?? null;
    const percent = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${Math.round(value * 1000) / 10}%`);
    const ms = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${value} мс`);
    const kbit = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${Math.round(value / 1000)} кбит/с`);
    const main = [
      `Качество: ${tierName(tier)}`,
      `Задержка: ${ms(summary?.rttMs)}`,
      `Потери: ${percent(summary?.lossRatio)}`,
      // What the encoder really sends against the tier's ceiling: the only proof that the limit took hold.
      `Кадры: ${summary?.framesPerSecond === undefined ? "неизвестно" : `${Math.round(summary.framesPerSecond)} из ${this.profile(tier).maxFramerate}`}`,
      `Размер: ${summary?.width && summary?.height ? `${summary.width}×${summary.height}` : "неизвестно"}`,
    ];
    const more = [
      `Оценка связи: ${score === null ? "неизвестно" : `${score} из 100`}`,
      `Ограничение видео: ${tierVia === "parameters" ? "параметры отправителя" : tierVia === "constraints" ? "настройки камеры" : tierVia === "none" ? "не применилось" : "неизвестно"}`,
      `У собеседника: ${link?.peerTier ? tierName(link.peerTier) : "неизвестно"}`,
      `Маршрут: ${link?.route ?? "неизвестно"}`,
      `Релей: ${this.turnMode === "on" ? "включён" : this.turnMode === "error" ? "не ответил, только прямое" : "выключен"}`,
      `Потери на приёме: ${percent(summary?.inboundLossRatio)}`,
      `Джиттер: ${ms(summary?.jitterMs)}`,
      `Битрейт: ${kbit(summary?.bitrate)}`,
      `Доступная полоса: ${kbit(summary?.availableOutgoingBitrate)}`,
      `Ограничение кодера: ${limitLabel(summary?.encoderLimit)}`,
      `Пропущенные кадры: ${percent(summary?.framesDroppedRatio)}`,
      `Восполнение звука: ${percent(summary?.concealmentRatio)}`,
    ];
    // In a conference the lines above are about one connection out of several. Say so, and say how many.
    if (links.length > 1) more.unshift(`В звонке: ${links.length + 1} из ${this.capacity}`, "Показано: самое слабое соединение");
    this.hooks.onDiagnostics(main, more);
    if (debugEnabled()) {
      // Numbers and tier names only. The same filter as the server logs drops anything that could carry SDP, ICE or a token.
      console.debug("wirecall", redactLogFields({ tier, score, peerTier: link?.peerTier ?? null, route: link?.route, links: links.length, ...numbersOf(summary) }));
    }
  }

  private async onForeground(): Promise<void> {
    const epoch = this.epoch;
    if (!this.isCurrent(epoch)) return;
    // Safari freezes the page in the background. The socket and the media path may be dead without any event.
    this.onNetworkChange();
    await this.requestWake(epoch);
    if (!this.isCurrent(epoch)) return;
    this.hooks.onPlayback?.();
    await this.restoreTracks();
  }

  private async restoreTracks(): Promise<void> {
    const epoch = this.epoch;
    const stream = this.localStream;
    if (!this.isCurrent(epoch) || !stream || this.restoring || this.switching) return;
    const ended = stream.getTracks().filter((track) => track.readyState === "ended");
    if (ended.length === 0) return;
    this.restoring = true;
    try {
      const supported = (navigator.mediaDevices.getSupportedConstraints?.() ?? null) as Record<string, boolean> | null;
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: ended.some((track) => track.kind === "audio") ? audioConstraints(supported) : false,
        video: ended.some((track) => track.kind === "video") ? videoConstraints(supported, this.facing) : false,
      });
      if (!this.isCurrent(epoch) || this.localStream !== stream) {
        fresh.getTracks().forEach((track) => track.stop());
        return;
      }
      for (const track of fresh.getTracks()) {
        applyMediaIntent(track, this.intent);
        this.watchTrack(track);
        const previous = stream.getTracks().find((item) => item.kind === track.kind);
        previous?.stop();
        if (previous) stream.removeTrack(previous);
        stream.addTrack(track);
        if (track.kind === "video") this.heldVideo = track;
        for (const link of this.links.values()) await link.swapTrack(previous, track, stream);
        if (!this.isCurrent(epoch)) {
          track.stop();
          return;
        }
      }
      this.localVideo.srcObject = stream;
      void this.localVideo.play().catch(() => undefined);
      await this.applyTiers(epoch);
      if (this.isCurrent(epoch)) this.hooks.onStatus("Камера и микрофон снова работают");
    } catch {
      if (this.isCurrent(epoch)) this.hooks.onStatus("Разрешите камеру и микрофон ещё раз");
    } finally {
      this.restoring = false;
    }
  }

  /** A track ends when headphones disconnect or iOS takes the camera away. It is reopened once the page is visible. */
  private watchTrack(track: MediaStreamTrack): void {
    // Tells the encoder what matters: clear speech for the microphone, a sharp picture for a face.
    try {
      track.contentHint = track.kind === "audio" ? "speech" : "detail";
    } catch {
      // Not every browser has the hint.
    }
    track.addEventListener?.("ended", () => {
      if (document.visibilityState === "visible") void this.restoreTracks();
    });
  }

  private async nextCamera(current: MediaStreamTrack | undefined): Promise<{ facing?: FacingMode; deviceId?: string }> {
    const cameras = await listCameras();
    const touch = (navigator.maxTouchPoints ?? 0) > 0;
    if (!touch && cameras.length >= 2) {
      // A Mac has no front and back. Its cameras, a Continuity iPhone among them, are cycled by id.
      const currentId = current?.getSettings?.().deviceId;
      const index = cameras.findIndex((camera) => camera.deviceId === currentId);
      const next = cameras[(index + 1) % cameras.length];
      if (next) return { deviceId: next.deviceId };
    }
    return { facing: this.facing === "user" ? "environment" : "user" };
  }

  private async openCamera(target: { facing?: FacingMode; deviceId?: string }): Promise<MediaStreamTrack | null> {
    const supported = (navigator.mediaDevices.getSupportedConstraints?.() ?? null) as Record<string, boolean> | null;
    const video = videoConstraints(supported, target.facing ?? this.facing);
    if (target.deviceId) {
      delete video.facingMode;
      video.deviceId = { exact: target.deviceId };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      return stream.getVideoTracks()[0] ?? null;
    } catch {
      return null;
    }
  }

  private markFacing(track: MediaStreamTrack | undefined): void {
    const reported = track?.getSettings?.().facingMode;
    // The back camera is shown as it is. A mirrored view is only natural for the selfie side.
    this.localVideo.dataset.facing = reported === "environment" || (!reported && this.facing === "environment") ? "environment" : "user";
  }

  private async reportCameras(): Promise<void> {
    const cameras = await listCameras();
    if (this.started && !this.closed) this.hooks.onCameras?.(cameras.length);
  }

  private async requestWake(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    const locks = navigator.wakeLock;
    if (!locks?.request) return;
    try {
      const lock = await locks.request("screen");
      if (!this.isCurrent(epoch)) {
        await lock.release();
        return;
      }
      this.wakeLock = lock;
    } catch {
      if (this.isCurrent(epoch)) this.wakeLock = null;
    }
  }

  private attachLifecycle(): void {
    if (this.listening) return;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    if (connection?.addEventListener) {
      this.networkTarget = connection;
      connection.addEventListener("change", this.onNetwork);
    }
    this.listening = true;
  }

  private detachLifecycle(): void {
    if (!this.listening) return;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onPageHide);
    this.networkTarget?.removeEventListener("change", this.onNetwork);
    this.networkTarget = null;
    this.listening = false;
  }

  private isCurrent(epoch: number): boolean {
    return epoch === this.epoch && !this.closed && this.started;
  }

  private finish(text: string, notifyServer: boolean, canRejoin = true): void {
    this.epoch += 1;
    this.closed = true;
    this.started = false;
    this.detachLifecycle();
    this.clearTimers();
    if (notifyServer && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "hangup" }));
    }
    this.socket?.close(1000, "hangup");
    this.socket = null;
    this.socketReady = false;
    this.stopMedia();
    this.hooks.onEnded(text, canRejoin);
    this.setPhase("ended");
  }

  private stopMedia(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.publishPeers();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.localVideo.srcObject = null;
    this.heldVideo = null;
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release();
  }

  private clearTimers(): void {
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.statsTimer);
    window.clearInterval(this.pingTimer);
    this.statsTimer = 0;
    this.pingTimer = 0;
    this.reconnectTimer = 0;
    window.clearTimeout(this.pongTimer);
    this.pongTimer = 0;
  }

  private resumeKey(): string {
    return `wirecall-resume:${this.roomId}`;
  }
}

function debugEnabled(): boolean {
  try {
    return localStorage.getItem("wirecall-debug") === "1";
  } catch {
    return false;
  }
}

function numbersOf(summary: StatSummary | undefined): Record<string, unknown> {
  if (!summary) return {};
  return Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "counters" && key !== "route"));
}

function limitLabel(limit: StatSummary["encoderLimit"]): string {
  if (limit === undefined) return "неизвестно";
  if (limit === "none") return "нет";
  if (limit === "bandwidth") return "полоса";
  if (limit === "cpu") return "процессор";
  return "другое";
}

async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? [];
    return devices.filter((device) => device.kind === "videoinput" && device.deviceId !== "");
  } catch {
    return [];
  }
}

function readToken(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeToken(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Private mode without storage: the call works, only a reload takes a new seat.
  }
}

function mediaIssueText(reason: "denied" | "missing" | "busy" | "failed"): string {
  if (reason === "denied") return "Нет доступа к камере и микрофону";
  if (reason === "missing") return "Камера или микрофон не найдены";
  if (reason === "busy") return "Камера или микрофон заняты";
  return "Не получилось включить камеру и микрофон";
}

function closeText(code: number, reason: string, capacity: number): string {
  if (code === 4000 || reason === "room-full") {
    return capacity > PAIR_CAPACITY ? `В конференции нет мест. В ней уже ${capacity} человек.` : "В комнате уже двое. Создайте новую ссылку.";
  }
  if (code === 4002 || reason === "replaced") return "Эта комната открыта в другом окне.";
  if (code === 4004 || reason === "expired") return "Ссылка устарела. Создайте новую.";
  if (reason === "rate") return "Слишком много попыток. Подождите немного.";
  if (code === 1000) return "Звонок завершён";
  return "Соединение закрыто";
}

function generationOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function welcomePeers(value: unknown): WelcomePeer[] {
  if (!Array.isArray(value)) return [];
  const peers: WelcomePeer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { peerId, gen, polite, online } = item as Record<string, unknown>;
    const generation = generationOf(gen);
    if (!isPeerId(peerId) || generation === null) continue;
    peers.push({ peerId, gen: generation, polite: polite === true, online: online === true });
  }
  return peers;
}

function worstTier(tiers: readonly QualityTier[]): QualityTier | null {
  let worst: QualityTier | null = null;
  for (const tier of tiers) {
    if (worst === null || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(worst)) worst = tier;
  }
  return worst;
}

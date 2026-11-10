import { AdaptiveController, TIER_ORDER, type QualityTier } from "../shared/adaptive";
import { RetryBudget } from "../shared/backoff";
import { preferredAudioCodecs, preferredVideoCodecs, type CodecCap } from "../shared/codecs";
import { sanitizeIceServers, type IceServer } from "../shared/ice-servers";
import { IceBuffer } from "../shared/ice-buffer";
import { encodeIcePayload, parseIcePayload, PROTOCOL_VERSION } from "../shared/protocol";
import { shouldCreateOffer, shouldIgnoreOffer, type SignalingState } from "../shared/negotiation";
import { summarizeStats, type StatCounters, type StatReport, type StatSummary } from "../shared/stats";
import { encodeQualityMessage, parseQualityMessage, qualityLabel } from "../shared/quality-label";
import { redactLogFields } from "../shared/redact";
import { isResumeToken } from "../shared/ids";
import { audioConstraints, type FacingMode, openCallMedia, videoConstraints } from "./open-media";
import {
  applyMediaIntent,
  applyVideoTier,
  freshMediaIntent,
  tuneAudioSender,
  toggleMediaIntent,
  type AudioSenderControl,
  type MediaIntent,
  type SenderParameters,
  type VideoSenderControl,
  type VideoTrackControl,
} from "./media-intent";

export type CallPhase = "idle" | "starting" | "waiting" | "connecting" | "live" | "trouble" | "ended";

export interface CallHooks {
  onStatus: (text: string) => void;
  onDiagnostics: (lines: string[]) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onMediaIssue: (reason: "denied" | "missing" | "busy" | "failed" | null) => void;
  onEnded: (text: string) => void;
  onWaiting: (waiting: boolean) => void;
  onPhase?: (phase: CallPhase) => void;
  /** This side's own outgoing leg, and the other person's when they report it over the data channel. */
  onQuality?: (tier: QualityTier, peerTier: QualityTier | null) => void;
  onCameras?: (count: number) => void;
}

interface WelcomeMessage {
  type: "welcome";
  peerId: string;
  polite: boolean;
  peerCount: number;
  resumed: boolean;
  turnMode: "off" | "on" | "error";
  iceServers: IceServer[];
  resumeToken?: string;
  expiresAt: number;
  gen?: number;
  peerOnline?: boolean;
}

interface Recovery {
  pc: RTCPeerConnection;
  /** ICE restarts made, or confirmed by the offering side. */
  restarts: number;
  /** Restart requests in a row that got no ack. */
  unacked: number;
  awaitingAck: boolean;
  rebuildAsked: boolean;
  exhausted: boolean;
}

const NO_RETRY = new Set([1000, 1008, 4000, 4002, 4004]);
const PING_EVERY_MS = 20_000;
const PONG_DEADLINE_MS = 10_000;
const PROBE_DEADLINE_MS = 4_000;
// A browser waits 15 to 30 seconds before it calls ICE failed. A restart after 8 usually connects at once,
// because the second STUN round goes through a NAT or VPN path the first one has already opened.
const CONNECT_WATCH_MS = 8_000;
// One ICE restart is an offer, an answer, new candidates and connectivity checks. On a slow mobile link with a
// relay that takes a few seconds. Ten leaves room for it without holding a dead call for long.
const RESTART_WAIT_MS = 10_000;
// The ack crosses the signaling server twice. Three seconds covers a one-second round trip with margin.
// Longer silence means the request or the other side is lost.
const ACK_WAIT_MS = 3_000;
const MAX_UNACKED = 3;
// After the answer to a restart arrives, connectivity checks on a working path finish within about a second.
// A second trigger inside this window is the same failure seen by the other side, not a new one.
const RESTART_SETTLE_MS = 2_000;
// The room answers a rebuild request after fetching TURN credentials, which it bounds at four seconds.
const REBUILD_WAIT_MS = 7_000;
const ICE_RESTART_TRIES = 2;
const MAX_REBUILDS = 4;
const STATS_WARMUP_MS = 8_000;
// Four missed reports in a row: the other side's tier is unknown again, not frozen at its last value.
const PEER_QUALITY_STALE_MS = 9_000;
// A little more buffer than the default smooths a jittery long-distance path without a delay people notice.
const AUDIO_JITTER_TARGET_MS = 100;

export class CallSession {
  private socket: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private polite = false;
  private peerCount = 0;
  private offeringPc: RTCPeerConnection | null = null;
  private iceBuffer = new IceBuffer();
  // About five minutes of attempts: long enough for a tunnel or a Wi-Fi to cellular handover.
  private signalRetry = new RetryBudget(40, 500, 8_000);
  private socketReady = false;
  private pongTimer = 0;
  private recoverTimer = 0;
  private recovery: Recovery | null = null;
  private lastRestartAt = 0;
  /** Generation of the current RTCPeerConnection. The room and the other side must name the same one. */
  private pcGen = -1;
  private peerOnline = false;
  private rebuilds = 0;
  private connectTimer = 0;
  private connectedAt = 0;
  private networkChangedAt = 0;
  private switching = false;
  private restoring = false;
  private closed = false;
  private iceRestart = false;
  private facing: FacingMode = "user";
  private quality = new AdaptiveController();
  private counters: StatCounters | undefined;
  private statsTimer = 0;
  private pingTimer = 0;
  private disconnectedTimer = 0;
  private reconnectTimer = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private turnMode: WelcomeMessage["turnMode"] = "off";
  private route = "неизвестно";
  private started = false;
  private epoch = 0;
  private intent: MediaIntent = freshMediaIntent();
  private heldVideo: VideoTrackControl | null = null;
  private qualityChannel: RTCDataChannel | null = null;
  private peerTier: QualityTier | null = null;
  private peerTierAt = 0;
  private savedIce: IceServer[] = [];
  private listening = false;
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

  constructor(
    private readonly roomId: string,
    private readonly localVideo: HTMLVideoElement,
    private readonly remoteVideo: HTMLVideoElement,
    private readonly hooks: CallHooks,
  ) {
    this.remoteVideo.srcObject = this.remoteStream;
    this.remoteVideo.playsInline = true;
    this.remoteVideo.autoplay = true;
    this.localVideo.playsInline = true;
    this.localVideo.autoplay = true;
    this.localVideo.muted = true;
  }

  async start(): Promise<void> {
    if (this.started && !this.closed) return;
    this.epoch += 1;
    const epoch = this.epoch;
    this.started = true;
    this.closed = false;
    this.stopMedia();
    this.signalRetry.reset();
    this.rebuilds = 0;
    // A new call judges its own link. It does not start from the weak tier the last one ended on.
    this.quality.reset();
    this.hooks.onPhase?.("starting");
    this.hooks.onStatus("Включаем камеру и микрофон");
    const media = await openCallMedia({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      supported: (navigator.mediaDevices.getSupportedConstraints?.() ?? null) as Record<string, boolean> | null,
      facingMode: this.facing,
    });
    if (!this.isCurrent(epoch)) {
      if (media.ok) media.stream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (!media.ok) {
      this.started = false;
      this.hooks.onMediaIssue(media.reason);
      this.hooks.onStatus(mediaIssueText(media.reason));
      this.hooks.onPhase?.("idle");
      return;
    }
    this.hooks.onMediaIssue(null);
    this.localStream = media.stream;
    for (const track of media.stream.getTracks()) {
      applyMediaIntent(track, this.intent);
      this.watchTrack(track);
    }
    this.heldVideo = media.stream.getVideoTracks()[0] ?? null;
    this.localVideo.srcObject = media.stream;
    this.markFacing(media.stream.getVideoTracks()[0]);
    void this.reportCameras();
    if (!media.video) this.hooks.onStatus("Камера недоступна. Звонок со звуком.");
    void this.localVideo.play().catch(() => undefined);
    this.attachLifecycle();
    await this.requestWake(epoch);
    if (!this.isCurrent(epoch)) return;
    this.connectSocket();
  }

  hangup(): void {
    this.finish("Звонок завершён", true);
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

  /** Starts a new connection on both sides. For the «Переподключить» button. */
  retry(): void {
    if (!this.isCurrent(this.epoch)) return;
    this.rebuilds = 0;
    this.stopRecovery();
    this.signalRetry.reset();
    this.hooks.onPhase?.("connecting");
    this.hooks.onStatus("Соединяем заново");
    const pc = this.pc;
    if (pc && this.socketReady && this.peerOnline) {
      this.recovery = { pc, restarts: ICE_RESTART_TRIES, unacked: 0, awaitingAck: false, rebuildAsked: false, exhausted: false };
      this.stepRecovery();
    } else {
      this.reconnectSocket();
    }
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
      const sender = this.pc?.getSenders().find((item) => item.track === previous) ?? this.videoSender();
      if (sender) await sender.replaceTrack(next);
      else this.pc?.addTrack(next, stream);
      if (!this.isCurrent(epoch)) return;
      await this.applyTier(this.quality.current(), epoch);
    } catch {
      if (this.isCurrent(epoch)) this.hooks.onStatus("Не удалось переключить камеру");
    } finally {
      this.switching = false;
    }
  }

  async playRemote(): Promise<void> {
    try {
      await this.remoteVideo.play();
      this.hooks.onAudioBlocked(false);
    } catch {
      this.hooks.onAudioBlocked(true);
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
      const hello: { type: "hello"; protocol: number; resume?: string; gen?: number } = { type: "hello", protocol: PROTOCOL_VERSION };
      if (resume && isResumeToken(resume)) hello.resume = resume;
      // Naming the generation tells the room this side still holds its media connection and wants to keep it.
      if (this.pc && this.pcGen >= 0) hello.gen = this.pcGen;
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
        this.finish(closeText(event.code, event.reason), false);
        return;
      }
      const delay = this.signalRetry.next();
      if (delay === null) {
        this.finish("Не удалось восстановить связь. Нажмите «Войти снова».", false);
        return;
      }
      const epoch = this.epoch;
      // Sound and picture go browser to browser. They survive a signaling drop until the room rebuilds the call.
      if (!this.pc || !iceUp(this.pc)) {
        this.hooks.onPhase?.("trouble");
        this.hooks.onStatus("Связь с комнатой прервалась. Пробуем снова.");
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
    if (message.type === "peer-left") {
      this.peerCount = typeof message.peerCount === "number" ? message.peerCount : 1;
      this.peerOnline = false;
      if (message.gone === false) {
        // Only the other side's signaling is away. Sound and picture go directly and may be perfectly fine.
        this.pauseRecovery();
        if (this.pc && !iceUp(this.pc)) this.hooks.onStatus("У собеседника пропала связь. Ждём его возвращения.");
        return;
      }
      this.dropConnection();
      this.clearRemote();
      this.hooks.onWaiting(true);
      this.hooks.onStatus("Собеседник вышел. Ждём возвращения.");
      this.hooks.onPhase?.("waiting");
      return;
    }
    if (message.type === "peer-joined" || message.type === "peer-back" || message.type === "rebuild") {
      const gen = generationOf(message.gen);
      if (gen === null) return;
      this.peerCount = typeof message.peerCount === "number" ? message.peerCount : 2;
      if (message.type !== "rebuild") this.peerOnline = true;
      this.adoptIce(message);
      if (this.pc && this.pcGen === gen) {
        // Same generation: the other side kept its connection and so does this one.
        this.resumeLink();
        return;
      }
      this.buildConnection(gen, this.savedIce);
      this.hooks.onWaiting(false);
      this.hooks.onStatus(message.type === "peer-joined" ? "Соединяем" : "Соединяем заново");
      this.hooks.onPhase?.("connecting");
      await this.negotiate();
      return;
    }
    if (message.type === "restart") {
      if (!this.pc || message.gen !== this.pcGen) return;
      if (message.ack === true) this.onRestartAck();
      else this.onRestartRequest();
      return;
    }
    if (message.type === "signal" && typeof message.payload === "string" && (message.kind === "offer" || message.kind === "answer" || message.kind === "ice")) {
      // SDP and candidates of another generation belong to a connection that no longer exists here.
      if (!this.pc || message.gen !== this.pcGen) return;
      await this.applySignal(message.kind, message.payload);
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
    this.polite = welcome.polite;
    this.peerCount = welcome.peerCount;
    this.peerOnline = welcome.peerOnline === true;
    this.turnMode = welcome.turnMode;
    this.savedIce = welcome.iceServers;
    if (welcome.resumeToken && isResumeToken(welcome.resumeToken)) writeToken(this.resumeKey(), welcome.resumeToken);
    const gen = generationOf(welcome.gen) ?? 0;
    if (welcome.peerCount < 2) {
      // Alone in the room. A connection is built when the other person arrives, with fresh ICE servers.
      this.dropConnection();
      this.clearRemote();
      this.hooks.onWaiting(true);
      this.hooks.onPhase?.("waiting");
    } else if (this.pc && this.pcGen === gen) {
      // Only the signaling socket was replaced. The media connection of this generation goes on untouched.
      this.resumeLink();
    } else {
      this.buildConnection(gen, welcome.iceServers);
      this.hooks.onWaiting(false);
      this.hooks.onPhase?.("connecting");
      await this.negotiate();
    }
    if (!this.isCurrent(epoch)) return;
    this.publishDiagnostics();
    this.startStats();
  }

  /** Signaling is back for a connection that was kept. Recovery continues only if the media path needs it. */
  private resumeLink(): void {
    const pc = this.pc;
    if (!pc) return;
    if (iceUp(pc)) {
      this.hooks.onStatus(this.linkStatus());
      this.hooks.onPhase?.("live");
      return;
    }
    if (this.recovery?.pc === pc) {
      if (!this.recovery.exhausted) this.stepRecovery();
    } else {
      this.beginRecovery();
    }
  }

  private buildConnection(gen: number, iceServers: IceServer[]): void {
    this.dropConnection();
    const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(iceServers) });
    this.pc = pc;
    this.pcGen = gen;
    // The last picture of the previous connection stays on screen, dimmed by the phase, until the new one delivers.
    const incoming = new MediaStream();
    this.remoteStream = incoming;
    for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream!);
    this.preferCodecs(pc);
    this.openQualityChannel(pc);
    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate || this.pc !== pc) return;
      this.sendSignal(
        "ice",
        encodeIcePayload({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }),
        gen,
      );
    });
    pc.addEventListener("track", (event) => {
      if (this.pc !== pc) return;
      // The stream the other side sent keeps sound and picture on one clock. A hand-built one is the fallback.
      const stream = event.streams[0] ?? incoming;
      if (stream === incoming && !incoming.getTracks().includes(event.track)) incoming.addTrack(event.track);
      this.remoteStream = stream;
      if (this.remoteVideo.srcObject !== stream) this.remoteVideo.srcObject = stream;
      if (event.track.kind === "audio") cushionAudio(event.receiver);
      void this.playRemote();
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (this.pc !== pc) return;
      this.onIceState(pc.iceConnectionState);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      // Safari reports a broken DTLS session here while ICE still looks connected. An ICE restart cannot fix that.
      if (pc.connectionState !== "failed") return;
      if (iceUp(pc)) {
        this.stopRecovery();
        this.recovery = { pc, restarts: ICE_RESTART_TRIES, unacked: 0, awaitingAck: false, rebuildAsked: false, exhausted: false };
        this.stepRecovery();
      } else {
        this.onIceState("failed");
      }
    });
  }

  /** Closes the connection and everything that belongs to it: timers, buffered candidates, counters. */
  private dropConnection(): void {
    const previous = this.pc;
    this.pc = null;
    this.pcGen = -1;
    previous?.close();
    this.stopRecovery();
    window.clearTimeout(this.disconnectedTimer);
    window.clearTimeout(this.connectTimer);
    this.connectedAt = 0;
    // Byte and packet counters start from zero on a new connection. A difference against old ones is meaningless.
    this.counters = undefined;
    this.iceRestart = false;
    this.lastRestartAt = 0;
    this.iceBuffer.reset();
    this.qualityChannel = null;
    this.peerTier = null;
  }

  /**
   * A channel both sides open with the same id, so it needs no signaling of its own. It carries one thing:
   * the name of this side's quality tier. If it never opens, the other person's tier simply stays unknown.
   */
  private openQualityChannel(pc: RTCPeerConnection): void {
    try {
      const channel = pc.createDataChannel("quality", { negotiated: true, id: 0 });
      this.qualityChannel = channel;
      channel.addEventListener("message", (event) => {
        if (this.pc !== pc) return;
        const tier = parseQualityMessage(event.data);
        if (!tier) return;
        this.peerTierAt = Date.now();
        if (tier === this.peerTier) return;
        this.peerTier = tier;
        this.publishQuality();
      });
      channel.addEventListener("open", () => {
        if (this.pc === pc) this.sendQuality();
      });
    } catch {
      this.qualityChannel = null;
    }
  }

  private sendQuality(): void {
    const channel = this.qualityChannel;
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(encodeQualityMessage(this.quality.current()));
    } catch {
      // The picture and the sound do not depend on this channel.
    }
  }

  private publishQuality(): void {
    if (this.peerTier && Date.now() - this.peerTierAt > PEER_QUALITY_STALE_MS) this.peerTier = null;
    this.hooks.onQuality?.(this.quality.current(), this.peerTier);
  }

  /** Voice first: a modest cap and high priority on the audio sender. The adaptation itself never touches audio. */
  private tuneAudio(pc: RTCPeerConnection): void {
    const sender = pc.getSenders().find((item) => item.track?.kind === "audio");
    if (sender) void tuneAudioSender(asAudioSender(sender));
  }

  private clearRemote(): void {
    this.remoteStream = new MediaStream();
    this.remoteVideo.srcObject = this.remoteStream;
  }

  private preferCodecs(pc: RTCPeerConnection): void {
    const video = rtcCapabilities("video");
    const audio = rtcCapabilities("audio");
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind;
      try {
        if (kind === "video" && video.length > 0) transceiver.setCodecPreferences?.(video as RTCRtpCodec[]);
        if (kind === "audio" && audio.length > 0) transceiver.setCodecPreferences?.(audio as RTCRtpCodec[]);
      } catch {
        // Safari can reject a preference list. The browser then keeps its own order.
      }
    }
  }

  private async negotiate(): Promise<void> {
    const pc = this.pc;
    const gen = this.pcGen;
    const epoch = this.epoch;
    if (!this.isCurrent(epoch) || !pc || this.peerCount < 2 || this.offeringPc === pc || pc.signalingState !== "stable") return;
    if (!shouldCreateOffer({ polite: this.polite })) {
      // Only the other side offers. If its offer never comes, the watchdog asks for one.
      this.armConnectWatch(pc);
      return;
    }
    this.offeringPc = pc;
    try {
      const offer = await pc.createOffer({ iceRestart: this.iceRestart });
      this.iceRestart = false;
      if (!this.isCurrent(epoch) || this.pc !== pc || pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp;
      if (this.isCurrent(epoch) && this.pc === pc && sdp) {
        this.sendSignal("offer", sdp, gen);
        if (!iceUp(pc)) this.armConnectWatch(pc);
      }
    } catch {
      if (this.pc === pc && !iceUp(pc)) this.armConnectWatch(pc);
    } finally {
      if (this.offeringPc === pc) this.offeringPc = null;
    }
  }

  private async restartIce(pc: RTCPeerConnection): Promise<void> {
    if (this.pc !== pc || this.polite || this.offeringPc === pc) return;
    this.lastRestartAt = Date.now();
    if (pc.signalingState === "have-local-offer") {
      // The answer to the last offer never came. Without a rollback no new offer can be made.
      try {
        await pc.setLocalDescription({ type: "rollback" });
      } catch {
        return;
      }
    }
    if (this.pc !== pc) return;
    this.iceRestart = true;
    await this.negotiate();
  }

  /** If the call has not connected in time, recovery takes over instead of waiting forever on «Соединяем». */
  private armConnectWatch(pc: RTCPeerConnection): void {
    window.clearTimeout(this.connectTimer);
    const epoch = this.epoch;
    this.connectTimer = window.setTimeout(() => {
      if (!this.isCurrent(epoch) || this.pc !== pc || iceUp(pc)) return;
      this.beginRecovery();
    }, CONNECT_WATCH_MS);
  }

  /** One recovery procedure per connection. A second trigger while it runs changes nothing. */
  private beginRecovery(): void {
    const pc = this.pc;
    if (!this.isCurrent(this.epoch) || !pc || this.peerCount < 2 || this.recovery?.pc === pc) return;
    window.clearTimeout(this.recoverTimer);
    this.recovery = { pc, restarts: 0, unacked: 0, awaitingAck: false, rebuildAsked: false, exhausted: false };
    this.stepRecovery();
  }

  /**
   * Signaling first, then ICE restarts on the same connection, then a new connection as the last step.
   * The offering side restarts by itself. The other side asks it to, and waits for an ack instead of guessing.
   */
  private stepRecovery(): void {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = 0;
    const run = this.recovery;
    const pc = this.pc;
    const epoch = this.epoch;
    if (!run || !pc || run.pc !== pc || !this.isCurrent(epoch) || this.peerCount < 2) {
      this.recovery = null;
      return;
    }
    if (iceUp(pc) && pc.connectionState !== "failed") {
      this.recovery = null;
      return;
    }
    this.hooks.onPhase?.("trouble");
    // Nothing can be agreed while a socket is away. The welcome or the peer's return continues from this step.
    if (!this.socketReady) {
      this.hooks.onStatus("Связь с комнатой прервалась. Пробуем снова.");
      return;
    }
    if (!this.peerOnline) {
      this.hooks.onStatus("У собеседника пропала связь. Ждём его возвращения.");
      return;
    }
    const again = (delay: number): void => {
      this.recoverTimer = window.setTimeout(() => {
        if (this.isCurrent(epoch)) this.stepRecovery();
      }, delay);
    };
    if (run.rebuildAsked) {
      // The room did not answer the rebuild request, so the socket is suspect. A new one continues from here.
      run.rebuildAsked = false;
      this.reconnectSocket();
      return;
    }
    if (run.restarts < ICE_RESTART_TRIES && run.unacked < MAX_UNACKED) {
      this.hooks.onStatus("Связь пропала. Восстанавливаем.");
      if (this.polite) {
        run.unacked += 1;
        run.awaitingAck = true;
        this.send({ type: "restart", gen: this.pcGen, ack: false });
        again(ACK_WAIT_MS);
      } else {
        run.restarts += 1;
        // A restart the other side has just asked for already covers this step.
        if (!this.restartInFlight(pc)) void this.restartIce(pc);
        again(RESTART_WAIT_MS);
      }
      return;
    }
    if (this.rebuilds >= MAX_REBUILDS) {
      run.exhausted = true;
      this.hooks.onStatus(
        this.turnMode === "on"
          ? "Не получается восстановить связь. Проверьте интернет и нажмите «Переподключить»."
          : "Прямое соединение через эту сеть не проходит. Проверьте интернет и нажмите «Переподключить».",
      );
      return;
    }
    this.rebuilds += 1;
    run.rebuildAsked = true;
    this.hooks.onStatus("Соединяем заново");
    // Both sides may ask at once. They name the same generation, so the room starts exactly one new one.
    this.send({ type: "rebuild", gen: this.pcGen });
    again(REBUILD_WAIT_MS);
  }

  /** The offering side confirmed the request. Now the restart itself gets its time. */
  private onRestartAck(): void {
    const run = this.recovery;
    if (!run || run.pc !== this.pc || !run.awaitingAck) return;
    run.awaitingAck = false;
    run.unacked = 0;
    run.restarts += 1;
    const epoch = this.epoch;
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = window.setTimeout(() => {
      if (this.isCurrent(epoch)) this.stepRecovery();
    }, RESTART_WAIT_MS);
  }

  /** The other side lost the media path. This side may see nothing wrong and restarts ICE anyway. */
  private onRestartRequest(): void {
    const pc = this.pc;
    if (!pc || this.polite) return;
    this.send({ type: "restart", gen: this.pcGen, ack: true });
    if (this.restartInFlight(pc)) return;
    void this.restartIce(pc);
  }

  /** True while an ICE restart is being negotiated or has only just been answered. */
  private restartInFlight(pc: RTCPeerConnection): boolean {
    if (this.offeringPc === pc || pc.signalingState === "have-local-offer") return this.lastRestartAt > 0;
    return this.lastRestartAt > 0 && Date.now() - this.lastRestartAt < RESTART_SETTLE_MS;
  }

  private pauseRecovery(): void {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = 0;
    if (this.recovery) {
      this.recovery.awaitingAck = false;
      this.recovery.rebuildAsked = false;
    }
  }

  private stopRecovery(): void {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = 0;
    this.recovery = null;
  }

  private async applySignal(kind: "offer" | "answer" | "ice", payload: string): Promise<void> {
    if (kind === "ice") await this.onRemoteIce(payload);
    else await this.onRemoteDescription(kind, payload);
  }

  private async onRemoteDescription(kind: "offer" | "answer", sdp: string): Promise<void> {
    const pc = this.pc;
    const gen = this.pcGen;
    if (!pc || !sdp.startsWith("v=")) return;
    // An answer to an offer that was rolled back or belongs to a replaced connection.
    if (kind === "answer" && pc.signalingState !== "have-local-offer") return;
    const ignore = shouldIgnoreOffer({
      polite: this.polite,
      makingOffer: this.offeringPc === pc,
      signalingState: pc.signalingState as SignalingState,
      descriptionType: kind,
    });
    if (ignore) return;
    if (kind === "offer" && (this.offeringPc === pc || pc.signalingState !== "stable")) {
      try {
        await pc.setLocalDescription({ type: "rollback" });
      } catch {
        return;
      }
    }
    const current = this.pc;
    if (!current) return;
    try {
      await current.setRemoteDescription({ type: kind, sdp });
      if (this.pc !== current) return;
      for (const payload of this.iceBuffer.markReady()) await this.addIce(payload);
      if (kind === "offer") {
        const answer = await current.createAnswer();
        if (this.pc !== current) return;
        await current.setLocalDescription(answer);
        if (this.pc === current && current.localDescription?.sdp) {
          this.sendSignal("answer", current.localDescription.sdp, gen);
          if (!iceUp(current)) this.armConnectWatch(current);
        }
      }
    } catch {
      // The watchdog and the recovery steps retry. A status here would only alarm the person on the call.
      if (this.pc === current && !iceUp(current)) this.armConnectWatch(current);
    }
  }

  private async onRemoteIce(payload: string): Promise<void> {
    for (const item of this.iceBuffer.push(payload)) await this.addIce(item);
  }

  private async addIce(payload: string): Promise<void> {
    const parsed = parseIcePayload(payload);
    const pc = this.pc;
    if (!parsed || !pc) return;
    try {
      await pc.addIceCandidate({ candidate: parsed.candidate, sdpMid: parsed.sdpMid, sdpMLineIndex: parsed.sdpMLineIndex });
    } catch {
      // One rejected candidate is not a failure. Others still connect the call.
    }
  }

  private onIceState(state: RTCIceConnectionState): void {
    window.clearTimeout(this.disconnectedTimer);
    this.remoteVideo.dataset.ice = state;
    const epoch = this.epoch;
    if (state === "connected" || state === "completed") {
      window.clearTimeout(this.connectTimer);
      this.stopRecovery();
      this.rebuilds = 0;
      // That restart is finished. A request that comes now is about a new failure.
      this.lastRestartAt = 0;
      this.hooks.onWaiting(false);
      this.hooks.onStatus(this.linkStatus());
      this.hooks.onPhase?.("live");
      if (!this.connectedAt) {
        this.connectedAt = Date.now();
        // A rebuilt connection starts with default encodings. The current ceiling is applied again.
        void this.applyTier(this.quality.current(), epoch);
        if (this.pc) this.tuneAudio(this.pc);
      }
      this.publishQuality();
      return;
    }
    // A running recovery owns the status line: it may be waiting for the room or for the other person.
    const announce = this.recovery?.pc !== this.pc;
    if (state === "failed") {
      this.hooks.onPhase?.("trouble");
      if (announce) this.hooks.onStatus("Связь пропала. Восстанавливаем.");
      this.beginRecovery();
      return;
    }
    if (state === "disconnected") {
      this.hooks.onPhase?.("trouble");
      if (announce) this.hooks.onStatus("Связь пропала. Восстанавливаем.");
      // Right after a network change there is nothing to wait for.
      const wait = Date.now() - this.networkChangedAt < 10_000 ? 500 : 3_000;
      this.disconnectedTimer = window.setTimeout(() => {
        if (!this.isCurrent(epoch)) return;
        const now = this.pc?.iceConnectionState;
        if (now === "disconnected" || now === "failed") this.beginRecovery();
      }, wait);
    }
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
    const pc = this.pc;
    if (pc && this.peerCount >= 2 && (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) this.beginRecovery();
  }

  private sendSignal(kind: "offer" | "answer" | "ice", payload: string, gen: number): void {
    this.send({ type: "signal", kind, payload, gen });
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
    const pc = this.pc;
    if (!this.isCurrent(epoch) || !pc) return;
    let reports: StatReport[] = [];
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        reports.push(report as unknown as StatReport);
      });
    } catch {
      reports = [];
    }
    const summary = summarizeStats(reports, this.counters, Date.now());
    this.counters = summary.counters;
    this.route = summary.route === "direct" ? "прямое" : summary.route === "relay" ? "релей" : "неизвестно";
    if (!this.isCurrent(epoch) || this.pc !== pc) return;
    // The bandwidth estimate starts low and climbs for a few seconds. Judging it then lowers quality for no reason.
    if (!this.connectedAt || Date.now() - this.connectedAt < STATS_WARMUP_MS) {
      this.publishDiagnostics(summary);
      return;
    }
    const before = this.quality.current();
    const decision = this.quality.observe({
      atMs: Date.now(),
      rttMs: summary.rttMs,
      lossRatio: summary.lossRatio,
      inboundLossRatio: summary.inboundLossRatio,
      jitterMs: summary.jitterMs,
      availableOutgoingBitrate: summary.availableOutgoingBitrate,
      framesDroppedRatio: summary.framesDroppedRatio,
      encoderLimit: summary.encoderLimit,
    });
    if (decision.changed) {
      await this.applyTier(decision.tier, epoch);
      if (!this.isCurrent(epoch)) return;
      // A fresh key frame lets the smaller picture appear at once instead of smearing in.
      if (TIER_ORDER.indexOf(decision.tier) < TIER_ORDER.indexOf(before)) requestKeyFrame(this.videoSender());
    }
    this.sendQuality();
    this.publishQuality();
    this.publishDiagnostics(summary);
  }

  /** Limits outgoing video to the tier. It never stops the video: that is the camera button's job alone. */
  private async applyTier(tier: QualityTier, epoch: number): Promise<void> {
    const sender = this.videoSender();
    if (!sender || !this.isCurrent(epoch)) return;
    await applyVideoTier(asVideoSender(sender), tier, this.intent);
  }

  private publishDiagnostics(summary?: StatSummary): void {
    const tier = this.quality.current();
    const score = this.quality.score();
    const percent = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${Math.round(value * 1000) / 10}%`);
    const ms = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${value} мс`);
    const kbit = (value: number | undefined): string => (value === undefined ? "неизвестно" : `${Math.round(value / 1000)} кбит/с`);
    const lines = [
      `Качество: ${tierLabel(tier)}`,
      `Оценка связи: ${score === null ? "неизвестно" : `${score} из 100`}`,
      `У собеседника: ${this.peerTier ? tierLabel(this.peerTier) : "неизвестно"}`,
      `Маршрут: ${this.route}`,
      `Релей: ${this.turnMode === "on" ? "включён" : this.turnMode === "error" ? "не ответил, только прямое" : "выключен"}`,
      `Задержка: ${ms(summary?.rttMs)}`,
      `Потери: ${percent(summary?.lossRatio)}`,
      `Потери на приёме: ${percent(summary?.inboundLossRatio)}`,
      `Джиттер: ${ms(summary?.jitterMs)}`,
      `Битрейт: ${kbit(summary?.bitrate)}`,
      `Доступная полоса: ${kbit(summary?.availableOutgoingBitrate)}`,
      `Ограничение кодера: ${limitLabel(summary?.encoderLimit)}`,
      `Кадры: ${summary?.framesPerSecond === undefined ? "неизвестно" : String(Math.round(summary.framesPerSecond))}`,
      `Размер: ${summary?.width && summary?.height ? `${summary.width}×${summary.height}` : "неизвестно"}`,
      `Пропущенные кадры: ${percent(summary?.framesDroppedRatio)}`,
      `Восполнение звука: ${percent(summary?.concealmentRatio)}`,
    ];
    this.hooks.onDiagnostics(lines);
    if (debugEnabled()) {
      // Numbers and tier names only. The same filter as the server logs drops anything that could carry SDP, ICE or a token.
      console.debug("wirecall", redactLogFields({ tier, score, peerTier: this.peerTier, route: this.route, ...numbersOf(summary) }));
    }
  }

  private async onForeground(): Promise<void> {
    const epoch = this.epoch;
    if (!this.isCurrent(epoch)) return;
    // Safari freezes the page in the background. The socket and the media path may be dead without any event.
    this.onNetworkChange();
    await this.requestWake(epoch);
    if (!this.isCurrent(epoch)) return;
    await this.playRemote();
    if (!this.isCurrent(epoch)) return;
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
        const sender = this.pc?.getSenders().find((item) => item.track === previous || (item.track === null && track.kind === "video"));
        if (sender) await sender.replaceTrack(track);
        else this.pc?.addTrack(track, stream);
        if (!this.isCurrent(epoch)) {
          track.stop();
          return;
        }
      }
      this.localVideo.srcObject = stream;
      void this.localVideo.play().catch(() => undefined);
      await this.applyTier(this.quality.current(), epoch);
      if (this.isCurrent(epoch)) this.hooks.onStatus("Устройства восстановлены в том состоянии, в котором вы их оставили.");
    } catch {
      if (this.isCurrent(epoch)) this.hooks.onStatus("После возвращения в Safari доступ к камере нужно разрешить снова");
    } finally {
      this.restoring = false;
    }
  }

  /** A track ends when headphones disconnect or iOS takes the camera away. It is reopened once the page is visible. */
  private watchTrack(track: MediaStreamTrack): void {
    // Tells the encoder what matters: clear speech for the microphone, smooth motion for a face.
    try {
      track.contentHint = track.kind === "audio" ? "speech" : "motion";
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

  private videoSender(): RTCRtpSender | undefined {
    return this.pc?.getSenders().find((item) => item.track?.kind === "video");
  }

  private finish(text: string, notifyServer: boolean): void {
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
    this.clearRemote();
    this.hooks.onEnded(text);
    this.hooks.onPhase?.("ended");
  }

  private linkStatus(): string {
    return "На связи";
  }

  private stopMedia(): void {
    this.dropConnection();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.localVideo.srcObject = null;
    this.heldVideo = null;
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release();
  }

  private clearTimers(): void {
    window.clearTimeout(this.disconnectedTimer);
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.statsTimer);
    window.clearInterval(this.pingTimer);
    this.statsTimer = 0;
    this.pingTimer = 0;
    this.disconnectedTimer = 0;
    this.reconnectTimer = 0;
    window.clearTimeout(this.pongTimer);
    window.clearTimeout(this.connectTimer);
    this.pongTimer = 0;
    this.connectTimer = 0;
    this.stopRecovery();
  }

  private resumeKey(): string {
    return `wirecall-resume:${this.roomId}`;
  }
}

function asVideoSender(sender: RTCRtpSender): VideoSenderControl {
  return {
    get track() {
      return sender.track as VideoTrackControl | null;
    },
    getParameters: () => sender.getParameters() as unknown as SenderParameters,
    setParameters: (params) => sender.setParameters(params as unknown as RTCRtpSendParameters),
  };
}

function asAudioSender(sender: RTCRtpSender): AudioSenderControl {
  return {
    getParameters: () => sender.getParameters() as unknown as SenderParameters,
    setParameters: (params) => sender.setParameters(params as unknown as RTCRtpSendParameters),
  };
}

function requestKeyFrame(sender: RTCRtpSender | undefined): void {
  const generate = (sender as (RTCRtpSender & { generateKeyFrame?: () => Promise<unknown> }) | undefined)?.generateKeyFrame;
  if (!sender || typeof generate !== "function") return;
  try {
    void generate.call(sender).catch(() => undefined);
  } catch {
    // The encoder sends a key frame by itself soon enough.
  }
}

function cushionAudio(receiver: RTCRtpReceiver): void {
  const target = receiver as unknown as Record<string, unknown>;
  try {
    if ("jitterBufferTarget" in target) target.jitterBufferTarget = AUDIO_JITTER_TARGET_MS;
    else if ("playoutDelayHint" in target) target.playoutDelayHint = AUDIO_JITTER_TARGET_MS / 1000;
  } catch {
    // The browser keeps its own buffer.
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

function rtcCapabilities(kind: "audio" | "video"): CodecCap[] {
  const caps = RTCRtpSender.getCapabilities?.(kind);
  if (!caps) return [];
  return kind === "video" ? preferredVideoCodecs(caps.codecs) : preferredAudioCodecs(caps.codecs);
}

function iceUp(pc: RTCPeerConnection): boolean {
  return pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
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

function tierLabel(tier: QualityTier): string {
  return qualityLabel(tier).replace(/^Связь /u, "");
}

function mediaIssueText(reason: "denied" | "missing" | "busy" | "failed"): string {
  if (reason === "denied") return "Нет разрешения на камеру или микрофон";
  if (reason === "missing") return "Камера или микрофон не найдены";
  if (reason === "busy") return "Камера или микрофон заняты другим приложением";
  return "Не удалось включить камеру и микрофон";
}

function closeText(code: number, reason: string): string {
  if (code === 4000 || reason === "room-full") return "В комнате уже двое. Попросите освободить место или создайте новую ссылку.";
  if (code === 4002 || reason === "replaced") return "Эта комната открыта в другом окне.";
  if (code === 4004 || reason === "expired") return "Ссылка устарела. Создайте новую.";
  if (reason === "rate") return "Слишком много попыток подряд. Подождите немного.";
  if (code === 1000) return "Звонок завершён";
  return "Соединение закрыто";
}

function generationOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

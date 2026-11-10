import { AdaptiveController, TIER_ORDER, type QualityTier, type TierProfile } from "../shared/adaptive";
import { preferredAudioCodecs, preferredVideoCodecs, type CodecCap } from "../shared/codecs";
import { sanitizeIceServers, type IceServer } from "../shared/ice-servers";
import { IceBuffer } from "../shared/ice-buffer";
import { encodeIcePayload, parseIcePayload } from "../shared/protocol";
import { shouldCreateOffer, shouldIgnoreOffer, type SignalingState } from "../shared/negotiation";
import { summarizeStats, type StatCounters, type StatReport, type StatSummary } from "../shared/stats";
import { encodeQualityMessage, parseQualityMessage } from "../shared/quality-label";
import {
  applyVideoTier,
  tuneAudioSender,
  type AudioSenderControl,
  type MediaIntent,
  type SenderParameters,
  type VideoSenderControl,
  type VideoTrackControl,
} from "./media-intent";

/** How one connection is doing. The call as a whole has more phases; these are the ones a single link can be in. */
export type LinkPhase = "connecting" | "live" | "trouble";

export type TurnMode = "off" | "on" | "error";

/** What a link needs from the call it belongs to: the socket, the camera and a place to report to. */
export interface LinkHost {
  epoch(): number;
  /** False once the call has ended or started again. Every step that waited for something checks it. */
  alive(epoch: number): boolean;
  socketReady(): boolean;
  send(message: object): void;
  reconnectSocket(): void;
  localStream(): MediaStream | null;
  intent(): MediaIntent;
  turnMode(): TurnMode;
  networkChangedAt(): number;
  /** The limits a tier means in this call. They are lower when the uplink is shared between several people. */
  profile(tier: QualityTier): TierProfile;
  linkStatus(link: PeerLink, text: string): void;
  linkPhase(link: PeerLink): void;
  /** The other person's stream changed or has a new track. */
  linkMedia(link: PeerLink): void;
  /** The other person reported a different tier. */
  linkQuality(link: PeerLink): void;
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

/**
 * The media connection to one other person: its RTCPeerConnection, the recovery of it, and the quality
 * ladder of the video sent over it. A call for two has one of these, a conference one per other person.
 */
export class PeerLink {
  /** This side answers on the link, the other one offers. */
  polite: boolean;
  /** The other person's signaling socket is there. Sound and picture do not depend on it. */
  online = true;
  phase: LinkPhase = "connecting";
  /** What the status line says about this link. Empty while it simply works. */
  note = "";
  remoteStream: MediaStream | null = null;
  peerTier: QualityTier | null = null;
  summary: StatSummary | undefined;
  route = "неизвестно";
  /** Which knob took the last tier. Shown in the diagnostics next to what the encoder really sends. */
  tierVia: "parameters" | "constraints" | "none" | null = null;
  readonly quality: AdaptiveController;

  private pc: RTCPeerConnection | null = null;
  /** Generation of the current RTCPeerConnection. The room and the other side must name the same one. */
  private pcGen = -1;
  private offeringPc: RTCPeerConnection | null = null;
  private iceBuffer = new IceBuffer();
  private recoverTimer = 0;
  private recovery: Recovery | null = null;
  private lastRestartAt = 0;
  private rebuilds = 0;
  private connectTimer = 0;
  private disconnectedTimer = 0;
  private connectedAt = 0;
  private iceRestart = false;
  private counters: StatCounters | undefined;
  private qualityChannel: RTCDataChannel | null = null;
  private peerTierAt = 0;
  private closed = false;

  constructor(
    readonly peerId: string,
    polite: boolean,
    private readonly host: LinkHost,
  ) {
    this.polite = polite;
    this.quality = new AdaptiveController((tier) => host.profile(tier));
  }

  get gen(): number {
    return this.pcGen;
  }

  hasConnection(): boolean {
    return this.pc !== null;
  }

  /** Sound and picture are flowing. */
  up(): boolean {
    return this.pc !== null && iceUp(this.pc);
  }

  /** True when the room names the generation this link already holds, so nothing has to be built. */
  holds(gen: number): boolean {
    return this.pc !== null && this.pcGen === gen;
  }

  build(gen: number, iceServers: IceServer[]): void {
    this.drop();
    const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(iceServers) });
    this.pc = pc;
    this.pcGen = gen;
    // The last picture of the previous connection stays on screen, dimmed by the phase, until the new one delivers.
    const incoming = new MediaStream();
    const local = this.host.localStream();
    for (const track of local?.getTracks() ?? []) pc.addTrack(track, local!);
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
      if (event.track.kind === "audio") cushionAudio(event.receiver);
      this.host.linkMedia(this);
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
  drop(): void {
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
    this.summary = undefined;
    this.iceRestart = false;
    this.lastRestartAt = 0;
    this.iceBuffer.reset();
    this.qualityChannel = null;
    this.peerTier = null;
  }

  /** The other person has left, or the call is over. Nothing of this link runs after it. */
  close(): void {
    this.closed = true;
    this.drop();
    this.remoteStream = null;
  }

  setStatus(text: string): void {
    this.note = text;
    this.host.linkStatus(this, text);
  }

  setPhase(phase: LinkPhase): void {
    this.phase = phase;
    this.host.linkPhase(this);
  }

  async negotiate(): Promise<void> {
    const pc = this.pc;
    const gen = this.pcGen;
    const epoch = this.host.epoch();
    if (!this.alive(epoch) || !pc || this.offeringPc === pc || pc.signalingState !== "stable") return;
    if (!shouldCreateOffer({ polite: this.polite })) {
      // Only the other side offers. If its offer never comes, the watchdog asks for one.
      this.armConnectWatch(pc);
      return;
    }
    this.offeringPc = pc;
    try {
      const offer = await pc.createOffer({ iceRestart: this.iceRestart });
      this.iceRestart = false;
      if (!this.alive(epoch) || this.pc !== pc || pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp;
      if (this.alive(epoch) && this.pc === pc && sdp) {
        this.sendSignal("offer", sdp, gen);
        if (!iceUp(pc)) this.armConnectWatch(pc);
      }
    } catch {
      if (this.pc === pc && !iceUp(pc)) this.armConnectWatch(pc);
    } finally {
      if (this.offeringPc === pc) this.offeringPc = null;
    }
  }

  /** Signaling is back for a connection that was kept. Recovery continues only if the media path needs it. */
  resume(): void {
    const pc = this.pc;
    if (!pc) return;
    if (iceUp(pc)) {
      this.setStatus("");
      this.setPhase("live");
      return;
    }
    if (this.recovery?.pc === pc) {
      if (!this.recovery.exhausted) this.stepRecovery();
    } else {
      this.beginRecovery();
    }
  }

  /** Starts over at the last step, a new connection, for the «Переподключить» button. False if that cannot be asked now. */
  retry(): boolean {
    this.rebuilds = 0;
    this.stopRecovery();
    const pc = this.pc;
    if (!pc || !this.host.socketReady() || !this.online) return false;
    this.recovery = { pc, restarts: ICE_RESTART_TRIES, unacked: 0, awaitingAck: false, rebuildAsked: false, exhausted: false };
    this.stepRecovery();
    return true;
  }

  onRestart(gen: number, ack: boolean): void {
    if (!this.pc || gen !== this.pcGen) return;
    if (ack) this.onRestartAck();
    else this.onRestartRequest();
  }

  async onSignal(kind: "offer" | "answer" | "ice", payload: string, gen: number): Promise<void> {
    // SDP and candidates of another generation belong to a connection that no longer exists here.
    if (!this.pc || gen !== this.pcGen) return;
    if (kind === "ice") await this.onRemoteIce(payload);
    else await this.onRemoteDescription(kind, payload);
  }

  /** The other person's socket is away. Nothing can be agreed with them until it is back. */
  pauseRecovery(): void {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = 0;
    if (this.recovery) {
      this.recovery.awaitingAck = false;
      this.recovery.rebuildAsked = false;
    }
  }

  networkChanged(): void {
    const pc = this.pc;
    if (pc && (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) this.beginRecovery();
  }

  /** Puts a new camera or microphone track in place of the old one on this connection. */
  async swapTrack(previous: MediaStreamTrack | undefined, next: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const senders = pc.getSenders();
    const sender =
      senders.find((item) => item.track !== null && item.track === previous) ??
      (next.kind === "video" ? (senders.find((item) => item.track?.kind === "video") ?? senders.find((item) => item.track === null)) : undefined);
    if (sender) await sender.replaceTrack(next);
    else pc.addTrack(next, stream);
  }

  /** Limits outgoing video to the current tier. It never stops the video: that is the camera button's job alone. */
  async applyTier(epoch: number): Promise<void> {
    const sender = this.videoSender();
    if (!sender || !this.alive(epoch)) return;
    const tier = this.quality.current();
    const result = await applyVideoTier(asVideoSender(sender), tier, this.host.intent(), this.host.profile(tier));
    if (this.alive(epoch)) this.tierVia = result.via;
  }

  /** One reading of getStats: the diagnostics, and a step of the quality ladder when the link asks for it. */
  async sample(): Promise<void> {
    const epoch = this.host.epoch();
    const pc = this.pc;
    if (!this.alive(epoch) || !pc) return;
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
    if (!this.alive(epoch) || this.pc !== pc) return;
    this.summary = summary;
    if (this.peerTier && Date.now() - this.peerTierAt > PEER_QUALITY_STALE_MS) this.peerTier = null;
    // The bandwidth estimate starts low and climbs for a few seconds. Judging it then lowers quality for no reason.
    if (!this.connectedAt || Date.now() - this.connectedAt < STATS_WARMUP_MS) return;
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
      await this.applyTier(epoch);
      if (!this.alive(epoch)) return;
      // A fresh key frame lets the cheaper picture appear at once instead of smearing in.
      if (TIER_ORDER.indexOf(decision.tier) < TIER_ORDER.indexOf(before)) requestKeyFrame(this.videoSender());
    }
    this.sendQuality();
  }

  private alive(epoch: number): boolean {
    return !this.closed && this.host.alive(epoch);
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
        this.host.linkQuality(this);
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

  /** Voice first: a modest cap and high priority on the audio sender. The adaptation itself never touches audio. */
  private tuneAudio(pc: RTCPeerConnection): void {
    const sender = pc.getSenders().find((item) => item.track?.kind === "audio");
    if (sender) void tuneAudioSender(asAudioSender(sender));
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

  /** If the link has not connected in time, recovery takes over instead of waiting forever on «Соединяем». */
  private armConnectWatch(pc: RTCPeerConnection): void {
    window.clearTimeout(this.connectTimer);
    const epoch = this.host.epoch();
    this.connectTimer = window.setTimeout(() => {
      if (!this.alive(epoch) || this.pc !== pc || iceUp(pc)) return;
      this.beginRecovery();
    }, CONNECT_WATCH_MS);
  }

  /** One recovery procedure per connection. A second trigger while it runs changes nothing. */
  private beginRecovery(): void {
    const pc = this.pc;
    if (!this.alive(this.host.epoch()) || !pc || this.recovery?.pc === pc) return;
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
    const epoch = this.host.epoch();
    if (!run || !pc || run.pc !== pc || !this.alive(epoch)) {
      this.recovery = null;
      return;
    }
    if (iceUp(pc) && pc.connectionState !== "failed") {
      this.recovery = null;
      return;
    }
    this.setPhase("trouble");
    // Nothing can be agreed while a socket is away. The welcome or the peer's return continues from this step.
    if (!this.host.socketReady()) {
      this.setStatus("Связь с комнатой прервалась. Пробуем снова.");
      return;
    }
    if (!this.online) {
      this.setStatus("У собеседника пропала связь. Ждём его возвращения.");
      return;
    }
    const again = (delay: number): void => {
      this.recoverTimer = window.setTimeout(() => {
        if (this.alive(epoch)) this.stepRecovery();
      }, delay);
    };
    if (run.rebuildAsked) {
      // The room did not answer the rebuild request, so the socket is suspect. A new one continues from here.
      run.rebuildAsked = false;
      this.host.reconnectSocket();
      return;
    }
    if (run.restarts < ICE_RESTART_TRIES && run.unacked < MAX_UNACKED) {
      this.setStatus("Связь пропала. Восстанавливаем.");
      if (this.polite) {
        run.unacked += 1;
        run.awaitingAck = true;
        this.host.send({ type: "restart", to: this.peerId, gen: this.pcGen, ack: false });
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
      this.setStatus(
        this.host.turnMode() === "on"
          ? "Связь не восстанавливается. Проверьте интернет."
          : "Через эту сеть звонок не проходит. Попробуйте другую.",
      );
      return;
    }
    this.rebuilds += 1;
    run.rebuildAsked = true;
    this.setStatus("Соединяем заново");
    // Both sides may ask at once. They name the same generation, so the room starts exactly one new one.
    this.host.send({ type: "rebuild", to: this.peerId, gen: this.pcGen });
    again(REBUILD_WAIT_MS);
  }

  /** The offering side confirmed the request. Now the restart itself gets its time. */
  private onRestartAck(): void {
    const run = this.recovery;
    if (!run || run.pc !== this.pc || !run.awaitingAck) return;
    run.awaitingAck = false;
    run.unacked = 0;
    run.restarts += 1;
    const epoch = this.host.epoch();
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = window.setTimeout(() => {
      if (this.alive(epoch)) this.stepRecovery();
    }, RESTART_WAIT_MS);
  }

  /** The other side lost the media path. This side may see nothing wrong and restarts ICE anyway. */
  private onRestartRequest(): void {
    const pc = this.pc;
    if (!pc || this.polite) return;
    this.host.send({ type: "restart", to: this.peerId, gen: this.pcGen, ack: true });
    if (this.restartInFlight(pc)) return;
    void this.restartIce(pc);
  }

  /** True while an ICE restart is being negotiated or has only just been answered. */
  private restartInFlight(pc: RTCPeerConnection): boolean {
    if (this.offeringPc === pc || pc.signalingState === "have-local-offer") return this.lastRestartAt > 0;
    return this.lastRestartAt > 0 && Date.now() - this.lastRestartAt < RESTART_SETTLE_MS;
  }

  private stopRecovery(): void {
    window.clearTimeout(this.recoverTimer);
    this.recoverTimer = 0;
    this.recovery = null;
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
    const epoch = this.host.epoch();
    if (state === "connected" || state === "completed") {
      window.clearTimeout(this.connectTimer);
      this.stopRecovery();
      this.rebuilds = 0;
      // That restart is finished. A request that comes now is about a new failure.
      this.lastRestartAt = 0;
      this.setStatus("");
      this.setPhase("live");
      if (!this.connectedAt) {
        this.connectedAt = Date.now();
        // A rebuilt connection starts with default encodings. The current ceiling is applied again.
        void this.applyTier(epoch);
        if (this.pc) this.tuneAudio(this.pc);
      }
      this.host.linkQuality(this);
      return;
    }
    // A running recovery owns the status line: it may be waiting for the room or for the other person.
    const announce = this.recovery?.pc !== this.pc;
    if (state === "failed") {
      this.setPhase("trouble");
      if (announce) this.setStatus("Связь пропала. Восстанавливаем.");
      this.beginRecovery();
      return;
    }
    if (state === "disconnected") {
      this.setPhase("trouble");
      if (announce) this.setStatus("Связь пропала. Восстанавливаем.");
      // Right after a network change there is nothing to wait for.
      const wait = Date.now() - this.host.networkChangedAt() < 10_000 ? 500 : 3_000;
      this.disconnectedTimer = window.setTimeout(() => {
        if (!this.alive(epoch)) return;
        const now = this.pc?.iceConnectionState;
        if (now === "disconnected" || now === "failed") this.beginRecovery();
      }, wait);
    }
  }

  private sendSignal(kind: "offer" | "answer" | "ice", payload: string, gen: number): void {
    this.host.send({ type: "signal", to: this.peerId, kind, payload, gen });
  }

  private videoSender(): RTCRtpSender | undefined {
    return this.pc?.getSenders().find((item) => item.track?.kind === "video");
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

function rtcCapabilities(kind: "audio" | "video"): CodecCap[] {
  const caps = RTCRtpSender.getCapabilities?.(kind);
  if (!caps) return [];
  return kind === "video" ? preferredVideoCodecs(caps.codecs) : preferredAudioCodecs(caps.codecs);
}

function iceUp(pc: RTCPeerConnection): boolean {
  return pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
}

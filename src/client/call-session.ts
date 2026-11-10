import { AdaptiveController, scaleForHeight, TIER_PROFILES, type QualityTier } from "../shared/adaptive";
import { RetryBudget } from "../shared/backoff";
import { preferredAudioCodecs, preferredVideoCodecs, type CodecCap } from "../shared/codecs";
import { sanitizeIceServers, type IceServer } from "../shared/ice-servers";
import { IceBuffer } from "../shared/ice-buffer";
import { encodeIcePayload, parseIcePayload } from "../shared/protocol";
import { shouldIgnoreOffer, type SignalingState } from "../shared/negotiation";
import { summarizeStats, type StatCounters, type StatReport } from "../shared/stats";
import { isResumeToken } from "../shared/ids";
import { type FacingMode, openCallMedia } from "./open-media";

export interface CallHooks {
  onStatus: (text: string) => void;
  onDiagnostics: (lines: string[]) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onMediaIssue: (reason: "denied" | "missing" | "busy" | "failed" | null) => void;
  onEnded: (text: string) => void;
  onWaiting: (waiting: boolean) => void;
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
}

const NO_RETRY = new Set([1000, 1008, 4000, 4002, 4004]);

export class CallSession {
  private socket: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private polite = false;
  private peerCount = 0;
  private makingOffer = false;
  private ignoreOffer = false;
  private iceBuffer = new IceBuffer();
  private signalRetry = new RetryBudget(8, 500, 10_000);
  private iceRetry = new RetryBudget(5, 1_000, 15_000);
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
  private iceGraceUntil = 0;
  private earlySignals: { kind: "offer" | "answer" | "ice"; payload: string }[] = [];

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
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.onForeground();
    });
    window.addEventListener("online", () => this.scheduleIceRestart());
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener?.("change", () => this.scheduleIceRestart());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    this.hooks.onStatus("Включаем камеру и микрофон");
    const media = await openCallMedia({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      supported: (navigator.mediaDevices.getSupportedConstraints?.() ?? null) as Record<string, boolean> | null,
      facingMode: this.facing,
    });
    if (!media.ok) {
      this.started = false;
      this.hooks.onMediaIssue(media.reason);
      this.hooks.onStatus(mediaIssueText(media.reason));
      return;
    }
    this.hooks.onMediaIssue(null);
    this.localStream = media.stream;
    this.localVideo.srcObject = media.stream;
    if (!media.video) this.hooks.onStatus("Камера недоступна. Звонок со звуком.");
    void this.localVideo.play().catch(() => undefined);
    await this.requestWake();
    this.connectSocket();
  }

  hangup(): void {
    this.closed = true;
    this.clearTimers();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "hangup" }));
    }
    this.socket?.close(1000, "hangup");
    this.stopMedia();
    this.hooks.onEnded("Звонок завершён");
  }

  toggleAudio(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  toggleVideo(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  async switchCamera(): Promise<void> {
    if (!this.localStream) return;
    this.facing = this.facing === "user" ? "environment" : "user";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      const next = stream.getVideoTracks()[0];
      if (!next) return;
      const previous = this.localStream.getVideoTracks()[0];
      previous?.stop();
      if (previous) this.localStream.removeTrack(previous);
      this.localStream.addTrack(next);
      this.localVideo.srcObject = this.localStream;
      const sender = this.pc?.getSenders().find((item) => item.track?.kind === "video" || item.track === null);
      if (sender) await sender.replaceTrack(next);
      else this.pc?.addTrack(next, this.localStream);
      await this.applyTier(this.quality.current());
    } catch {
      this.hooks.onStatus("Не удалось переключить камеру");
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

  async requestUpgrade(): Promise<void> {
    const decision = this.quality.requestUpgrade(Date.now());
    if (decision.changed) await this.applyTier(decision.tier);
    this.publishDiagnostics();
  }

  private connectSocket(): void {
    if (this.closed) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${this.roomId}/socket`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.signalRetry.reset();
      const resume = sessionStorage.getItem(this.resumeKey());
      const hello: { type: "hello"; protocol: 1; resume?: string } = { type: "hello", protocol: 1 };
      if (resume && isResumeToken(resume)) hello.resume = resume;
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      void this.onServerMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      if (NO_RETRY.has(event.code)) {
        this.hooks.onEnded(closeText(event.code, event.reason));
        return;
      }
      const delay = this.signalRetry.next();
      if (delay === null) {
        this.hooks.onEnded("Не удалось восстановить связь. Нажмите «Войти» ещё раз.");
        this.started = false;
        return;
      }
      this.hooks.onStatus("Связь с комнатой прервалась. Пробуем снова.");
      this.reconnectTimer = window.setTimeout(() => this.connectSocket(), delay);
    });
  }

  private async onServerMessage(raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "welcome") {
      await this.onWelcome(message as unknown as WelcomeMessage);
      return;
    }
    if (message.type === "pong") return;
    if (message.type === "peer-joined") {
      this.peerCount = typeof message.peerCount === "number" ? message.peerCount : 2;
      this.hooks.onWaiting(false);
      await this.negotiate();
      return;
    }
    if (message.type === "peer-left") {
      this.peerCount = typeof message.peerCount === "number" ? message.peerCount : 1;
      this.hooks.onWaiting(true);
      this.hooks.onStatus("Собеседник вышел. Ждём возвращения.");
      this.resetPeerConnection();
      return;
    }
    if (message.type === "peer-reset") {
      this.peerCount = typeof message.peerCount === "number" ? message.peerCount : 2;
      this.resetPeerConnection();
      await this.negotiate();
      return;
    }
    if (message.type === "signal" && typeof message.payload === "string" && (message.kind === "offer" || message.kind === "answer" || message.kind === "ice")) {
      if (!this.pc) {
        this.earlySignals.push({ kind: message.kind, payload: message.payload });
        return;
      }
      await this.applySignal(message.kind, message.payload);
    }
  }

  private async onWelcome(welcome: WelcomeMessage): Promise<void> {
    this.polite = welcome.polite;
    this.peerCount = welcome.peerCount;
    this.turnMode = welcome.turnMode;
    if (welcome.resumeToken && isResumeToken(welcome.resumeToken)) {
      sessionStorage.setItem(this.resumeKey(), welcome.resumeToken);
    }
    if (welcome.resumed || !this.pc) this.resetPeerConnection(welcome.iceServers);
    else this.ensurePeerConnection(welcome.iceServers);
    this.hooks.onWaiting(welcome.peerCount < 2);
    this.hooks.onStatus(welcome.peerCount < 2 ? "Ждём второго человека" : "Соединяем");
    if (welcome.turnMode === "off") this.hooks.onStatus(welcome.peerCount < 2 ? "Ждём второго человека. Релей выключен: только прямое соединение." : "Соединяем напрямую");
    const early = this.earlySignals;
    this.earlySignals = [];
    for (const signal of early) await this.applySignal(signal.kind, signal.payload);
    if (welcome.peerCount >= 2) await this.negotiate();
    this.publishDiagnostics();
    this.startStats();
  }

  private ensurePeerConnection(iceServers: IceServer[]): void {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: sanitizeIceServers(iceServers) });
    this.pc = pc;
    this.iceGraceUntil = Date.now() + 5_000;
    this.iceBuffer.reset();
    for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream!);
    this.preferCodecs(pc);
    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.sendSignal(
        "ice",
        encodeIcePayload({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }),
      );
    });
    pc.addEventListener("track", (event) => {
      if (!this.remoteStream.getTracks().includes(event.track)) this.remoteStream.addTrack(event.track);
      void this.playRemote();
    });
    pc.addEventListener("iceconnectionstatechange", () => this.onIceState(pc.iceConnectionState));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        this.iceRetry.reset();
        this.hooks.onWaiting(false);
        this.hooks.onStatus(this.quality.current() === "audio-only" ? "На связи, только звук" : "На связи");
      }
    });
  }

  private resetPeerConnection(iceServers?: IceServer[]): void {
    this.pc?.close();
    this.pc = null;
    this.iceBuffer.reset();
    this.remoteStream = new MediaStream();
    this.remoteVideo.srcObject = this.remoteStream;
    if (iceServers) this.ensurePeerConnection(iceServers);
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
    if (!pc || this.peerCount < 2 || this.makingOffer || pc.signalingState !== "stable") return;
    this.makingOffer = true;
    try {
      const offer = await pc.createOffer({ iceRestart: this.iceRestart });
      this.iceRestart = false;
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp;
      if (sdp) this.sendSignal("offer", sdp);
    } catch {
      this.hooks.onStatus("Не удалось начать соединение. Пробуем ещё раз.");
    } finally {
      this.makingOffer = false;
    }
  }

  private async applySignal(kind: "offer" | "answer" | "ice", payload: string): Promise<void> {
    if (kind === "ice") await this.onRemoteIce(payload);
    else await this.onRemoteDescription(kind, payload);
  }

  private async onRemoteDescription(kind: "offer" | "answer", sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || !sdp.startsWith("v=")) return;
    const ignore = shouldIgnoreOffer({
      polite: this.polite,
      makingOffer: this.makingOffer,
      signalingState: pc.signalingState as SignalingState,
      descriptionType: kind,
    });
    this.ignoreOffer = ignore;
    if (ignore) return;
    if (kind === "offer" && (this.makingOffer || pc.signalingState !== "stable")) {
      try {
        await pc.setLocalDescription({ type: "rollback" });
      } catch {
        this.resetPeerConnection(sanitizeIceServers(pc.getConfiguration().iceServers as IceServer[]));
      }
    }
    const current = this.pc;
    if (!current) return;
    try {
      await current.setRemoteDescription({ type: kind, sdp });
      for (const payload of this.iceBuffer.markReady()) await this.addIce(payload);
      if (kind === "offer") {
        const answer = await current.createAnswer();
        await current.setLocalDescription(answer);
        if (current.localDescription?.sdp) this.sendSignal("answer", current.localDescription.sdp);
      }
    } catch {
      this.hooks.onStatus("Не удалось принять описание связи");
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
      if (!this.ignoreOffer) this.hooks.onStatus("Кандидат связи отклонён");
    }
  }

  private onIceState(state: RTCIceConnectionState): void {
    window.clearTimeout(this.disconnectedTimer);
    this.remoteVideo.dataset.ice = state;
    if (state === "connected" || state === "completed") {
      this.iceRetry.reset();
      this.hooks.onWaiting(false);
      this.hooks.onStatus(this.quality.current() === "audio-only" ? "На связи, только звук" : "На связи");
      return;
    }
    if (Date.now() < this.iceGraceUntil && state !== "failed") return;
    if (state === "failed") {
      this.scheduleIceRestart();
      return;
    }
    if (state === "disconnected") {
      this.hooks.onStatus("Связь пропала. Восстанавливаем.");
      this.disconnectedTimer = window.setTimeout(() => {
        if (this.pc?.iceConnectionState === "disconnected") this.scheduleIceRestart();
      }, 3_000);
    }
  }

  private scheduleIceRestart(): void {
    if (this.closed || !this.pc) return;
    const delay = this.iceRetry.next();
    if (delay === null) {
      this.hooks.onStatus("Автоматически восстановить связь не получилось. Нажмите «Ещё раз».");
      return;
    }
    window.setTimeout(() => {
      this.iceRestart = true;
      void this.negotiate();
    }, delay);
  }

  private sendSignal(kind: "offer" | "answer" | "ice", payload: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "signal", kind, payload }));
  }

  private startStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = window.setInterval(() => void this.sampleStats(), 2000);
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
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
    const decision = this.quality.observe({
      atMs: Date.now(),
      rttMs: summary.rttMs,
      lossRatio: summary.lossRatio,
      availableOutgoingBitrate: summary.availableOutgoingBitrate,
    });
    if (decision.changed) await this.applyTier(decision.tier);
    if (decision.tier === "audio-only" && decision.changed) this.hooks.onStatus("Связь слабая. Оставили звук.");
    this.publishDiagnostics(summary);
  }

  private async applyTier(tier: QualityTier): Promise<void> {
    const sender = this.pc?.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return;
    const profile = TIER_PROFILES[tier];
    try {
      const params = sender.getParameters();
      const current = params.encodings[0] ?? {};
      if (tier === "audio-only") {
        params.encodings = [{ ...current, active: false }];
      } else {
        params.encodings = [{
          ...current,
          active: true,
          maxBitrate: profile.maxBitrate,
          maxFramerate: profile.maxFramerate,
          scaleResolutionDownBy: scaleForHeight(sender.track?.getSettings().height, tier),
        }];
        params.degradationPreference = "balanced";
      }
      await sender.setParameters(params);
    } catch {
      // getStats-driven hints are optional. The browser congestion controller still runs.
    }
  }

  private publishDiagnostics(summary?: { rttMs?: number; lossRatio?: number; framesPerSecond?: number; width?: number; height?: number; bitrate?: number }): void {
    const tier = this.quality.current();
    this.hooks.onDiagnostics([
      `Маршрут: ${this.route}`,
      `Релей: ${this.turnMode === "on" ? "включён" : this.turnMode === "error" ? "не ответил, только прямое" : "выключен"}`,
      `Задержка: ${summary?.rttMs === undefined ? "неизвестно" : `${summary.rttMs} мс`}`,
      `Потери: ${summary?.lossRatio === undefined ? "неизвестно" : `${Math.round(summary.lossRatio * 1000) / 10}%`}`,
      `Кадры: ${summary?.framesPerSecond === undefined ? "неизвестно" : String(Math.round(summary.framesPerSecond))}`,
      `Размер: ${summary?.width && summary?.height ? `${summary.width}×${summary.height}` : "неизвестно"}`,
      `Битрейт: ${summary?.bitrate === undefined ? "неизвестно" : `${Math.round(summary.bitrate / 1000)} кбит/с`}`,
      `Качество: ${tierLabel(tier)}`,
    ]);
  }

  private async onForeground(): Promise<void> {
    await this.requestWake();
    await this.playRemote();
    const stream = this.localStream;
    if (!stream) return;
    const ended = stream.getTracks().filter((track) => track.readyState === "ended");
    if (ended.length === 0) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: ended.some((track) => track.kind === "audio"),
        video: ended.some((track) => track.kind === "video") ? { facingMode: this.facing } : false,
      });
      for (const track of fresh.getTracks()) {
        const previous = stream.getTracks().find((item) => item.kind === track.kind);
        previous?.stop();
        if (previous) stream.removeTrack(previous);
        stream.addTrack(track);
        const sender = this.pc?.getSenders().find((item) => item.track === previous || (item.track === null && track.kind === "video"));
        if (sender) await sender.replaceTrack(track);
        else this.pc?.addTrack(track, stream);
      }
      this.localVideo.srcObject = stream;
      this.hooks.onStatus("Камера и микрофон включены снова");
    } catch {
      this.hooks.onStatus("После возвращения в Safari доступ к камере нужно разрешить снова");
    }
  }

  private async requestWake(): Promise<void> {
    const locks = navigator.wakeLock;
    if (!locks?.request) return;
    try {
      this.wakeLock = await locks.request("screen");
    } catch {
      this.wakeLock = null;
    }
  }

  private stopMedia(): void {
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    void this.wakeLock?.release();
  }

  private clearTimers(): void {
    window.clearTimeout(this.disconnectedTimer);
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.statsTimer);
    window.clearInterval(this.pingTimer);
  }

  private resumeKey(): string {
    return `wirecall-resume:${this.roomId}`;
  }
}

function rtcCapabilities(kind: "audio" | "video"): CodecCap[] {
  const caps = RTCRtpSender.getCapabilities?.(kind);
  if (!caps) return [];
  return kind === "video" ? preferredVideoCodecs(caps.codecs) : preferredAudioCodecs(caps.codecs);
}

function tierLabel(tier: QualityTier): string {
  if (tier === "high") return "высокое";
  if (tier === "medium") return "обычное";
  if (tier === "low") return "экономия";
  return "только звук";
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

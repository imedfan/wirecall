import { readStatNumber, routeFromCandidateType, type RouteLabel } from "./diagnostics";

export interface StatReport {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface StatCounters {
  atMs: number;
  bytesSent?: number;
  packetsSent?: number;
  packetsLost?: number;
  audioPacketsSent?: number;
  audioPacketsLost?: number;
  inboundPackets?: number;
  inboundLost?: number;
  framesDecoded?: number;
  framesDropped?: number;
  concealedSamples?: number;
  totalSamples?: number;
}

export type EncoderLimitReason = "none" | "bandwidth" | "cpu" | "other";

/** Every field the browser did not report stays undefined. Unknown is never shown or scored as zero. */
export interface StatSummary {
  route: RouteLabel;
  rttMs?: number;
  /** Outgoing loss over the last interval, video and audio together, as the other side counted it. */
  lossRatio?: number;
  /** Incoming loss over the last interval, video and audio together. */
  inboundLossRatio?: number;
  /** Jitter of what this side sends, as the other side measured it. */
  jitterMs?: number;
  /** Jitter of what this side receives. */
  inboundJitterMs?: number;
  framesPerSecond?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  availableOutgoingBitrate?: number;
  encoderLimit?: EncoderLimitReason;
  /** Share of incoming frames dropped before display over the last interval. */
  framesDroppedRatio?: number;
  /** Share of incoming audio the browser had to invent to cover a gap. */
  concealmentRatio?: number;
  counters: StatCounters;
}

export function summarizeStats(reports: readonly StatReport[], previous: StatCounters | undefined, nowMs: number): StatSummary {
  const pair = selectedPair(reports);
  const local = pair ? reports.find((report) => report.id === pair.localCandidateId) : undefined;
  const find = (type: string, kind: string) => reports.find((report) => report.type === type && mediaKind(report) === kind && report.isRemote !== true);
  const outbound = find("outbound-rtp", "video");
  const outboundAudio = find("outbound-rtp", "audio");
  const remoteInbound = find("remote-inbound-rtp", "video");
  const remoteInboundAudio = find("remote-inbound-rtp", "audio");
  const inbound = find("inbound-rtp", "video");
  const inboundAudio = find("inbound-rtp", "audio");

  const counters: StatCounters = {
    atMs: nowMs,
    bytesSent: readStatNumber(outbound?.bytesSent),
    packetsSent: readStatNumber(outbound?.packetsSent),
    packetsLost: readStatNumber(remoteInbound?.packetsLost) ?? readStatNumber(outbound?.packetsLost),
    audioPacketsSent: readStatNumber(outboundAudio?.packetsSent),
    audioPacketsLost: readStatNumber(remoteInboundAudio?.packetsLost),
    inboundPackets: sum(readStatNumber(inbound?.packetsReceived), readStatNumber(inboundAudio?.packetsReceived)),
    inboundLost: sum(readStatNumber(inbound?.packetsLost), readStatNumber(inboundAudio?.packetsLost)),
    framesDecoded: readStatNumber(inbound?.framesDecoded),
    framesDropped: readStatNumber(inbound?.framesDropped),
    concealedSamples: readStatNumber(inboundAudio?.concealedSamples),
    totalSamples: readStatNumber(inboundAudio?.totalSamplesReceived),
  };

  const rttSeconds = readStatNumber(pair?.currentRoundTripTime) ?? readStatNumber(remoteInbound?.roundTripTime) ?? readStatNumber(remoteInboundAudio?.roundTripTime);
  let bitrate: number | undefined;
  const bytes = delta(counters.bytesSent, previous?.bytesSent);
  if (previous && bytes !== undefined) {
    const elapsed = (nowMs - previous.atMs) / 1000;
    if (elapsed > 0) bitrate = Math.round((bytes * 8) / elapsed);
  }
  const videoLoss = ratio(delta(counters.packetsLost, previous?.packetsLost), delta(counters.packetsSent, previous?.packetsSent));
  const audioLoss = ratio(delta(counters.audioPacketsLost, previous?.audioPacketsLost), delta(counters.audioPacketsSent, previous?.audioPacketsSent));
  const received = delta(counters.inboundPackets, previous?.inboundPackets);
  const lostIn = delta(counters.inboundLost, previous?.inboundLost);
  const decoded = delta(counters.framesDecoded, previous?.framesDecoded);
  const dropped = delta(counters.framesDropped, previous?.framesDropped);
  const concealed = delta(counters.concealedSamples, previous?.concealedSamples);
  const samples = delta(counters.totalSamples, previous?.totalSamples);
  const jitter = worst(readStatNumber(remoteInbound?.jitter), readStatNumber(remoteInboundAudio?.jitter));
  const inboundJitter = worst(readStatNumber(inbound?.jitter), readStatNumber(inboundAudio?.jitter));

  return {
    route: routeFromCandidateType(typeof local?.candidateType === "string" ? local.candidateType : undefined),
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    // Voice and picture share the path. The worse of the two is the honest figure.
    lossRatio: worst(videoLoss, audioLoss),
    inboundLossRatio: received !== undefined && lostIn !== undefined && received + lostIn > 0 ? Math.min(1, lostIn / (received + lostIn)) : undefined,
    jitterMs: jitter === undefined ? undefined : Math.round(jitter * 1000),
    inboundJitterMs: inboundJitter === undefined ? undefined : Math.round(inboundJitter * 1000),
    framesPerSecond: readStatNumber(outbound?.framesPerSecond),
    width: readStatNumber(outbound?.frameWidth),
    height: readStatNumber(outbound?.frameHeight),
    bitrate,
    availableOutgoingBitrate: readStatNumber(pair?.availableOutgoingBitrate),
    encoderLimit: encoderLimit(outbound?.qualityLimitationReason),
    framesDroppedRatio: decoded !== undefined && dropped !== undefined && decoded + dropped > 0 ? dropped / (decoded + dropped) : undefined,
    concealmentRatio: concealed !== undefined && samples !== undefined && samples > 0 ? Math.min(1, concealed / samples) : undefined,
    counters,
  };
}

function mediaKind(report: StatReport): unknown {
  // Older Safari names the field mediaType.
  return report.kind ?? report.mediaType;
}

function encoderLimit(value: unknown): EncoderLimitReason | undefined {
  if (value === "none" || value === "bandwidth" || value === "cpu" || value === "other") return value;
  return undefined;
}

/** Growth of a counter since the last sample. A counter that went backwards belongs to another stream. */
function delta(now: number | undefined, before: number | undefined): number | undefined {
  if (now === undefined || before === undefined || now < before) return undefined;
  return now - before;
}

function ratio(lost: number | undefined, sent: number | undefined): number | undefined {
  if (lost === undefined || sent === undefined || sent <= 0) return undefined;
  return Math.min(1, lost / (sent + lost));
}

function worst(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function selectedPair(reports: readonly StatReport[]): StatReport | undefined {
  // After an ICE restart several pairs stay nominated. The transport names the one in use.
  const transport = reports.find((report) => report.type === "transport" && typeof report.selectedCandidatePairId === "string");
  const named = transport ? reports.find((report) => report.type === "candidate-pair" && report.id === transport.selectedCandidatePairId) : undefined;
  if (named) return named;
  const pairs = reports.filter((report) => report.type === "candidate-pair");
  return (
    pairs.find((report) => report.selected === true) ??
    pairs.find((report) => report.nominated === true && report.state === "succeeded") ??
    pairs.find((report) => report.nominated === true)
  );
}

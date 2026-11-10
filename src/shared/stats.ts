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
}

export interface StatSummary {
  route: RouteLabel;
  rttMs?: number;
  lossRatio?: number;
  framesPerSecond?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  availableOutgoingBitrate?: number;
  counters: StatCounters;
}

export function summarizeStats(reports: readonly StatReport[], previous: StatCounters | undefined, nowMs: number): StatSummary {
  const pair = selectedPair(reports);
  const local = pair ? reports.find((report) => report.id === pair.localCandidateId) : undefined;
  const outbound = reports.find((report) => report.type === "outbound-rtp" && report.kind === "video" && report.isRemote !== true);
  const remoteInbound = reports.find((report) => report.type === "remote-inbound-rtp" && report.kind === "video");
  const bytesSent = readStatNumber(outbound?.bytesSent);
  const packetsSent = readStatNumber(outbound?.packetsSent);
  const packetsLost = readStatNumber(remoteInbound?.packetsLost) ?? readStatNumber(outbound?.packetsLost);
  const rttSeconds = readStatNumber(pair?.currentRoundTripTime) ?? readStatNumber(remoteInbound?.roundTripTime);
  let bitrate: number | undefined;
  let lossRatio: number | undefined;
  if (previous && bytesSent !== undefined && previous.bytesSent !== undefined) {
    const elapsed = (nowMs - previous.atMs) / 1000;
    const delta = bytesSent - previous.bytesSent;
    if (elapsed > 0 && delta >= 0) bitrate = Math.round((delta * 8) / elapsed);
  }
  if (previous && packetsSent !== undefined && previous.packetsSent !== undefined && packetsLost !== undefined && previous.packetsLost !== undefined) {
    const sent = packetsSent - previous.packetsSent;
    const lost = packetsLost - previous.packetsLost;
    if (sent > 0 && lost >= 0) lossRatio = Math.min(1, lost / (sent + lost));
  }
  return {
    route: routeFromCandidateType(typeof local?.candidateType === "string" ? local.candidateType : undefined),
    rttMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    lossRatio,
    framesPerSecond: readStatNumber(outbound?.framesPerSecond),
    width: readStatNumber(outbound?.frameWidth),
    height: readStatNumber(outbound?.frameHeight),
    bitrate,
    availableOutgoingBitrate: readStatNumber(pair?.availableOutgoingBitrate),
    counters: { atMs: nowMs, bytesSent, packetsSent, packetsLost },
  };
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

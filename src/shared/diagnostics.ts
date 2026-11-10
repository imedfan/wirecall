export type RouteLabel = "direct" | "relay" | "unknown";

export function routeFromCandidateType(candidateType: string | undefined): RouteLabel {
  if (!candidateType) return "unknown";
  if (candidateType === "relay") return "relay";
  if (candidateType === "host" || candidateType === "srflx" || candidateType === "prflx") return "direct";
  return "unknown";
}

export interface DiagnosticNumbers {
  rttMs?: number;
  lossRatio?: number;
  framesPerSecond?: number;
  width?: number;
  height?: number;
  bitrate?: number;
}

export function readStatNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

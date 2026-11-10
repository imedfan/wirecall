export type QualityTier = "high" | "medium" | "low" | "audio-only";

export interface TierProfile {
  tier: QualityTier;
  maxBitrate: number;
  maxFramerate: number;
  targetHeight: number;
}

export interface NetworkSample {
  atMs: number;
  rttMs?: number;
  lossRatio?: number;
  availableOutgoingBitrate?: number;
}

export interface ControllerDecision {
  tier: QualityTier;
  changed: boolean;
  reason: string;
}

const ORDER: QualityTier[] = ["audio-only", "low", "medium", "high"];

export const TIER_PROFILES: Record<QualityTier, TierProfile> = {
  high: { tier: "high", maxBitrate: 2_400_000, maxFramerate: 30, targetHeight: 1080 },
  medium: { tier: "medium", maxBitrate: 1_100_000, maxFramerate: 30, targetHeight: 720 },
  low: { tier: "low", maxBitrate: 350_000, maxFramerate: 24, targetHeight: 360 },
  "audio-only": { tier: "audio-only", maxBitrate: 0, maxFramerate: 0, targetHeight: 0 },
};

const MIN_SAMPLE_GAP_MS = 1_500;
const STREAK_DOWN = 2;
const STREAK_UP = 5;
const COOLDOWN_DOWN_MS = 6_000;
const COOLDOWN_UP_MS = 12_000;
const SEVERE_LOSS = 0.15;
const SEVERE_RTT_MS = 800;

export class AdaptiveController {
  private tier: QualityTier = "medium";
  private badStreak = 0;
  private goodStreak = 0;
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  observe(sample: NetworkSample): ControllerDecision {
    if (sample.atMs - this.lastSampleAt < MIN_SAMPLE_GAP_MS) {
      return { tier: this.tier, changed: false, reason: "gap" };
    }
    this.lastSampleAt = sample.atMs;
    const kind = classify(sample, this.tier);
    if (kind === "unknown") return { tier: this.tier, changed: false, reason: "unknown" };
    if (kind === "neutral") {
      this.badStreak = 0;
      this.goodStreak = 0;
      return { tier: this.tier, changed: false, reason: "hold" };
    }
    if (kind === "bad" || kind === "severe") {
      this.goodStreak = 0;
      this.badStreak = kind === "severe" ? STREAK_DOWN : this.badStreak + 1;
      if (this.badStreak < STREAK_DOWN) return { tier: this.tier, changed: false, reason: "bad-streak" };
      if (sample.atMs - this.lastChangeAt < COOLDOWN_DOWN_MS) {
        return { tier: this.tier, changed: false, reason: "cooldown" };
      }
      return this.stepDown(sample.atMs);
    }
    this.badStreak = 0;
    this.goodStreak += 1;
    if (this.goodStreak < STREAK_UP) return { tier: this.tier, changed: false, reason: "good-streak" };
    if (sample.atMs - this.lastChangeAt < COOLDOWN_UP_MS) {
      return { tier: this.tier, changed: false, reason: "cooldown" };
    }
    const next = neighbor(this.tier, 1);
    if (!next) return { tier: this.tier, changed: false, reason: "ceiling" };
    if (next === "high" && !bitrateSupports(sample, "high")) {
      return { tier: this.tier, changed: false, reason: "high-needs-bitrate" };
    }
    return this.commit(next, sample.atMs, "up");
  }

  requestUpgrade(nowMs: number): ControllerDecision {
    const next = neighbor(this.tier, 1);
    if (!next) return { tier: this.tier, changed: false, reason: "ceiling" };
    return this.commit(next, nowMs, "manual-up");
  }

  current(): QualityTier {
    return this.tier;
  }

  private stepDown(nowMs: number): ControllerDecision {
    const next = neighbor(this.tier, -1);
    if (!next) return { tier: this.tier, changed: false, reason: "floor" };
    return this.commit(next, nowMs, "down");
  }

  private commit(tier: QualityTier, nowMs: number, reason: string): ControllerDecision {
    this.tier = tier;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.lastChangeAt = nowMs;
    this.lastSampleAt = nowMs;
    return { tier, changed: true, reason };
  }
}

export function scaleForHeight(actualHeight: number | undefined, tier: QualityTier): number {
  const target = TIER_PROFILES[tier].targetHeight;
  if (tier === "audio-only") return 1;
  if (!actualHeight || actualHeight <= 0 || target <= 0) return tier === "low" ? 2 : 1;
  return Math.max(1, actualHeight / target);
}

function classify(sample: NetworkSample, tier: QualityTier): "bad" | "severe" | "good" | "neutral" | "unknown" {
  const hasLoss = typeof sample.lossRatio === "number" && Number.isFinite(sample.lossRatio);
  const hasRtt = typeof sample.rttMs === "number" && Number.isFinite(sample.rttMs);
  const hasBitrate = typeof sample.availableOutgoingBitrate === "number" && Number.isFinite(sample.availableOutgoingBitrate);
  if (!hasLoss && !hasRtt && !hasBitrate) return "unknown";

  const severe =
    (hasLoss && sample.lossRatio! >= SEVERE_LOSS) || (hasRtt && sample.rttMs! >= SEVERE_RTT_MS);
  const needed = TIER_PROFILES[tier].maxBitrate;
  const bad =
    severe ||
    (hasLoss && sample.lossRatio! >= 0.06) ||
    (hasRtt && sample.rttMs! >= 350) ||
    (hasBitrate && tier !== "audio-only" && sample.availableOutgoingBitrate! < needed * 0.65);
  if (bad) return severe ? "severe" : "bad";

  const next = neighbor(tier, 1);
  if (!next) return "neutral";
  const lossOk = !hasLoss || sample.lossRatio! <= 0.015;
  const rttOk = !hasRtt || sample.rttMs! <= 160;
  const bitrateOk = !hasBitrate || bitrateSupports(sample, next);
  if (lossOk && rttOk && bitrateOk) return "good";
  return "neutral";
}

function bitrateSupports(sample: NetworkSample, tier: QualityTier): boolean {
  if (typeof sample.availableOutgoingBitrate !== "number") return false;
  return sample.availableOutgoingBitrate >= TIER_PROFILES[tier].maxBitrate * 1.25;
}

function neighbor(tier: QualityTier, direction: -1 | 1): QualityTier | null {
  const index = ORDER.indexOf(tier) + direction;
  if (index < 0 || index >= ORDER.length) return null;
  return ORDER[index] ?? null;
}

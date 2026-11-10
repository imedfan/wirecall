/**
 * Quality ladder for outgoing video. Every tier keeps the picture: a weak link gets fewer frames a second
 * first, because in a conversation a sharp face matters more than smooth motion. The frame itself shrinks
 * only on the lowest tier. Only the person turns the camera off. Audio is not touched here.
 */
export type QualityTier = "good" | "ok" | "weak" | "very-weak";

export interface TierProfile {
  tier: QualityTier;
  maxBitrate: number;
  maxFramerate: number;
  /** Length of the shorter side of the frame, the "p" in 720p. */
  targetHeight: number;
}

export type EncoderLimit = "none" | "bandwidth" | "cpu" | "other";

/** One reading of the link. A field the browser does not report stays undefined: unknown is not zero. */
export interface NetworkSample {
  atMs: number;
  rttMs?: number;
  /** Loss on the outgoing leg, as the other side reports it. */
  lossRatio?: number;
  /** Loss on the incoming leg. Used when the outgoing one is unknown, as it often is on Safari. */
  inboundLossRatio?: number;
  jitterMs?: number;
  availableOutgoingBitrate?: number;
  framesDroppedRatio?: number;
  encoderLimit?: EncoderLimit;
}

export interface ControllerDecision {
  tier: QualityTier;
  changed: boolean;
  reason: string;
  /** Smoothed score from 0 to 100, or null when the browser gave nothing to judge by. */
  score: number | null;
}

/** Worst to best. */
export const TIER_ORDER: readonly QualityTier[] = ["very-weak", "weak", "ok", "good"];
export const START_TIER: QualityTier = "good";

export const TIER_PROFILES: Record<QualityTier, TierProfile> = {
  good: { tier: "good", maxBitrate: 1_200_000, maxFramerate: 30, targetHeight: 720 },
  ok: { tier: "ok", maxBitrate: 800_000, maxFramerate: 20, targetHeight: 720 },
  weak: { tier: "weak", maxBitrate: 500_000, maxFramerate: 15, targetHeight: 720 },
  // 15 and not 12: an even frame interval at 12 depends on the encoder, and that is not known in advance.
  "very-weak": { tier: "very-weak", maxBitrate: 250_000, maxFramerate: 15, targetHeight: 480 },
};

const MIN_SAMPLE_GAP_MS = 1_500;
// Down fast, up slowly: a call that stutters is worse than one that stays modest a little too long.
const STREAK_DOWN = 2;
const STREAK_UP = 5;
const COOLDOWN_DOWN_MS = 6_000;
const COOLDOWN_UP_MS = 12_000;
const COOLDOWN_UP_MAX_MS = 120_000;
/** A step up that had to be taken back this soon was a mistake. The next one waits longer. */
const FAILED_UP_MS = 30_000;
/** A raw score this low is a collapse: one step down at once, without waiting for a streak. */
const SEVERE_SCORE = 10;
/** The score must clear the next tier's floor by this much before stepping up, so it does not hover on the edge. */
const UP_MARGIN = 10;
/** Weight of the newest sample. One spike moves the average about halfway, two in a row carry it. */
const SMOOTHING = 0.6;
/** A value not reported for this many samples is unknown again. */
const STALE_SAMPLES = 3;
/** The current tier needs this share of its bitrate to be worth keeping. */
const KEEP_BITRATE = 0.65;
/** The next tier needs this much headroom before trying it. */
const UP_BITRATE = 1.25;
/** An encoder that already cuts quality by itself cannot be on a good link. */
const LIMITED_SCORE_CAP = 70;

const SCORE_FLOOR: Record<QualityTier, number> = { good: 80, ok: 55, weak: 30, "very-weak": 0 };

type Curve = readonly (readonly [number, number])[];
// Each curve maps a measurement to 0..100. The anchors are the points where a call visibly changes character.
const LOSS_CURVE: Curve = [[0.015, 100], [0.03, 80], [0.06, 50], [0.15, 0]];
const RTT_CURVE: Curve = [[160, 100], [250, 80], [350, 50], [800, 0]];
const JITTER_CURVE: Curve = [[30, 100], [60, 80], [100, 50], [200, 0]];
const DROPPED_CURVE: Curve = [[0.05, 100], [0.1, 80], [0.2, 50], [0.5, 0]];

/**
 * Scores one sample from 0 (unusable) to 100 (clean). The weakest signal decides: low delay does not
 * make up for lost packets. Returns null when there is nothing reliable to judge by.
 * Bitrate is not part of the score. It limits the tier separately, see fitsBitrate.
 */
export function scoreSample(sample: Omit<NetworkSample, "atMs">): number | null {
  const parts: number[] = [];
  const loss = known(sample.lossRatio) ?? known(sample.inboundLossRatio);
  if (loss !== undefined) parts.push(curve(LOSS_CURVE, loss));
  const rtt = known(sample.rttMs);
  if (rtt !== undefined) parts.push(curve(RTT_CURVE, rtt));
  const jitter = known(sample.jitterMs);
  if (jitter !== undefined) parts.push(curve(JITTER_CURVE, jitter));
  const dropped = known(sample.framesDroppedRatio);
  if (dropped !== undefined) parts.push(curve(DROPPED_CURVE, dropped));
  const limited = sample.encoderLimit === "bandwidth" || sample.encoderLimit === "cpu";
  if (limited) parts.push(LIMITED_SCORE_CAP);
  if (parts.length === 0) return null;
  return Math.round(Math.min(...parts));
}

/** The tier a score deserves. */
export function tierForScore(score: number): QualityTier {
  if (score >= SCORE_FLOOR.good) return "good";
  if (score >= SCORE_FLOOR.ok) return "ok";
  if (score >= SCORE_FLOOR.weak) return "weak";
  return "very-weak";
}

export class AdaptiveController {
  private tier: QualityTier = START_TIER;
  private badStreak = 0;
  private goodStreak = 0;
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private lastUpAt = Number.NEGATIVE_INFINITY;
  private upCooldownMs = COOLDOWN_UP_MS;
  private smooth = new Smoother();
  private lastScore: number | null = null;

  observe(sample: NetworkSample): ControllerDecision {
    if (sample.atMs - this.lastSampleAt < MIN_SAMPLE_GAP_MS) return this.hold("gap");
    this.lastSampleAt = sample.atMs;
    const rawScore = scoreSample(sample);
    const smoothed = this.smooth.add(sample);
    const score = scoreSample(smoothed);
    const bitrate = known(smoothed.availableOutgoingBitrate);
    this.lastScore = score;
    if (score === null && bitrate === undefined) return this.hold("unknown");

    const severe = rawScore !== null && rawScore <= SEVERE_SCORE;
    const deserved = score === null ? this.tier : tierForScore(score);
    const starved = bitrate !== undefined && bitrate < TIER_PROFILES[this.tier].maxBitrate * KEEP_BITRATE;
    if (severe || starved || rank(deserved) < rank(this.tier)) {
      this.goodStreak = 0;
      this.badStreak = severe ? STREAK_DOWN : this.badStreak + 1;
      if (this.badStreak < STREAK_DOWN) return this.hold("bad-streak");
      if (sample.atMs - this.lastChangeAt < COOLDOWN_DOWN_MS) return this.hold("cooldown");
      return this.stepDown(sample.atMs, severe ? "severe" : starved ? "bitrate" : "down");
    }

    this.badStreak = 0;
    const next = neighbor(this.tier, 1);
    if (!next) return this.hold("ceiling");
    const limited = smoothed.encoderLimit === "bandwidth" || smoothed.encoderLimit === "cpu";
    // Without any score there is no evidence the link is good. Bitrate alone only ever lowers the tier.
    const clean = score !== null && score >= SCORE_FLOOR[next] + UP_MARGIN && !limited;
    const room = bitrate === undefined || bitrate >= TIER_PROFILES[next].maxBitrate * UP_BITRATE;
    if (!clean || !room) {
      this.goodStreak = 0;
      return this.hold(clean ? "needs-bitrate" : "hold");
    }
    this.goodStreak += 1;
    if (this.goodStreak < STREAK_UP) return this.hold("good-streak");
    if (sample.atMs - this.lastChangeAt < this.upCooldownMs) return this.hold("cooldown");
    this.lastUpAt = sample.atMs;
    return this.commit(next, sample.atMs, "up");
  }

  current(): QualityTier {
    return this.tier;
  }

  /** Smoothed score of the last sample, for the diagnostics sheet. */
  score(): number | null {
    return this.lastScore;
  }

  /** A new call starts from the top again. It does not inherit the weak link the last one ended on. */
  reset(): void {
    this.tier = START_TIER;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.lastSampleAt = Number.NEGATIVE_INFINITY;
    this.lastChangeAt = Number.NEGATIVE_INFINITY;
    this.lastUpAt = Number.NEGATIVE_INFINITY;
    this.upCooldownMs = COOLDOWN_UP_MS;
    this.smooth = new Smoother();
    this.lastScore = null;
  }

  private stepDown(nowMs: number, reason: string): ControllerDecision {
    const next = neighbor(this.tier, -1);
    // The lowest tier still sends video. There is nothing below it to fall to.
    if (!next) return this.hold("floor");
    // Browsers that report no bitrate let the tier climb onto a link that cannot carry it. Each failed climb waits longer.
    this.upCooldownMs = nowMs - this.lastUpAt < FAILED_UP_MS ? Math.min(this.upCooldownMs * 2, COOLDOWN_UP_MAX_MS) : COOLDOWN_UP_MS;
    return this.commit(next, nowMs, reason);
  }

  private commit(tier: QualityTier, nowMs: number, reason: string): ControllerDecision {
    this.tier = tier;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.lastChangeAt = nowMs;
    return { tier, changed: true, reason, score: this.lastScore };
  }

  private hold(reason: string): ControllerDecision {
    return { tier: this.tier, changed: false, reason, score: this.lastScore };
  }
}

/** How much to shrink the frame so its shorter side matches the tier. Never enlarges. */
export function scaleForHeight(actualShortSide: number | undefined, tier: QualityTier): number {
  const target = TIER_PROFILES[tier].targetHeight;
  if (!actualShortSide || actualShortSide <= 0) return Math.max(1, TIER_PROFILES[START_TIER].targetHeight / target);
  return Math.max(1, actualShortSide / target);
}

/** Exponential average per field. Keeps a two-second spike from deciding anything by itself. */
class Smoother {
  private values: Partial<Record<NumericField, number>> = {};
  private missed: Partial<Record<NumericField, number>> = {};
  private limits: EncoderLimit[] = [];

  add(sample: NetworkSample): Omit<NetworkSample, "atMs"> {
    const out: Omit<NetworkSample, "atMs"> = {};
    for (const field of NUMERIC_FIELDS) {
      const value = known(sample[field]);
      if (value === undefined) {
        const missed = (this.missed[field] ?? 0) + 1;
        this.missed[field] = missed;
        if (missed >= STALE_SAMPLES) delete this.values[field];
      } else {
        const previous = this.values[field];
        this.values[field] = previous === undefined ? value : previous + SMOOTHING * (value - previous);
        this.missed[field] = 0;
      }
      const current = this.values[field];
      if (current !== undefined) out[field] = current;
    }
    // The encoder counts as limited only when it says so twice in a row.
    this.limits = [...this.limits, sample.encoderLimit ?? "none"].slice(-2);
    const last = this.limits[this.limits.length - 1];
    if (last && last !== "none" && this.limits.length === 2 && this.limits[0] === last) out.encoderLimit = last;
    return out;
  }
}

type NumericField = "rttMs" | "lossRatio" | "inboundLossRatio" | "jitterMs" | "availableOutgoingBitrate" | "framesDroppedRatio";
const NUMERIC_FIELDS: readonly NumericField[] = ["rttMs", "lossRatio", "inboundLossRatio", "jitterMs", "availableOutgoingBitrate", "framesDroppedRatio"];

function known(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function curve(points: Curve, value: number): number {
  const first = points[0]!;
  if (value <= first[0]) return first[1];
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x0, y0] = points[index - 1]!;
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1]![1];
}

function rank(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier);
}

function neighbor(tier: QualityTier, direction: -1 | 1): QualityTier | null {
  return TIER_ORDER[rank(tier) + direction] ?? null;
}

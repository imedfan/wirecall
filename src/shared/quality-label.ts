import { TIER_ORDER, type QualityTier } from "./adaptive";

export interface QualityBadge {
  /** Lit bars out of four. The count carries the meaning together with the text, colour only supports it. */
  bars: number;
  text: string;
  /** The other person's own outgoing leg, only when they really reported it and it is worse than good. */
  peerText: string | null;
  /** What a screen reader announces. */
  spoken: string;
}

const OWN: Record<QualityTier, string> = {
  good: "Связь хорошая",
  // A thinner link sends fewer frames a second and keeps the picture sharp, so that is what the badge says.
  ok: "Связь нормальная · кадры реже",
  weak: "Связь слабая · кадры реже",
  "very-weak": "Связь слабая · кадры реже",
};

const PEER: Record<QualityTier, string> = {
  good: "У собеседника связь хорошая",
  ok: "У собеседника связь нормальная",
  weak: "У собеседника связь слабая",
  "very-weak": "У собеседника связь слабая",
};

const NAME: Record<QualityTier, string> = {
  good: "хорошая",
  ok: "нормальная",
  weak: "слабая",
  "very-weak": "очень слабая",
};

/** The bare tier name for the diagnostics sheet, where the two lowest tiers must stay apart. */
export function tierName(tier: QualityTier): string {
  return NAME[tier];
}

export function qualityLabel(tier: QualityTier): string {
  return OWN[tier];
}

export function qualityBars(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier) + 1;
}

export function qualityBadge(tier: QualityTier, peerTier: QualityTier | null): QualityBadge {
  // A good link on the other side is not news. The line appears only when theirs is worse than good.
  const peerText = peerTier && peerTier !== "good" ? PEER[peerTier] : null;
  return {
    bars: qualityBars(tier),
    text: OWN[tier],
    peerText,
    spoken: peerText ? `${OWN[tier]}. ${peerText}.` : `${OWN[tier]}.`,
  };
}

/** The only thing sent over the quality channel: the tier name. No ids, tokens, SDP or candidates. */
export function encodeQualityMessage(tier: QualityTier): string {
  return JSON.stringify({ v: 1, tier });
}

export function parseQualityMessage(raw: unknown): QualityTier | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  try {
    const value = JSON.parse(raw) as { v?: unknown; tier?: unknown };
    if (!value || typeof value !== "object" || value.v !== 1) return null;
    return TIER_ORDER.find((tier) => tier === value.tier) ?? null;
  } catch {
    return null;
  }
}

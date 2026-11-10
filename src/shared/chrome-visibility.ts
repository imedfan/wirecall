import { TIER_ORDER, type QualityTier } from "./adaptive";

/** Rules for hiding the call controls. The view owns the timers and the DOM, this file owns the decisions. */
export const AUTO_HIDE_TOUCH_MS = 4_000;
export const AUTO_HIDE_MOUSE_MS = 3_000;

export type InputKind = "touch" | "mouse" | "key";

export interface ChromeContext {
  phase: string;
  /** The settings or the diagnostics sheet is open. */
  sheetOpen: boolean;
  /** A control holds keyboard focus, so someone is walking the buttons with Tab. */
  keyboardFocus: boolean;
  tier: QualityTier;
}

/** Weak and very weak: the person should keep seeing the warning. */
export function isWeakTier(tier: QualityTier): boolean {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf("weak");
}

/** A tap may hide the controls only during a live call, with no sheet open and no keyboard focus on them. */
export function mayHide(context: ChromeContext): boolean {
  return context.phase === "live" && !context.sheetOpen && !context.keyboardFocus;
}

/** Hiding by itself is stricter: it also waits while the link is weak. */
export function mayAutoHide(context: ChromeContext): boolean {
  return mayHide(context) && !isWeakTier(context.tier);
}

export function autoHideDelay(input: InputKind): number {
  return input === "mouse" ? AUTO_HIDE_MOUSE_MS : AUTO_HIDE_TOUCH_MS;
}

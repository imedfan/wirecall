import { describe, expect, it } from "vitest";
import { autoHideDelay, isWeakTier, mayAutoHide, mayHide, type ChromeContext } from "../../src/shared/chrome-visibility";

const live: ChromeContext = { phase: "live", sheetOpen: false, keyboardFocus: false, tier: "good" };

describe("hiding the call controls", () => {
  it("hides only during a live call", () => {
    expect(mayAutoHide(live)).toBe(true);
    for (const phase of ["idle", "starting", "waiting", "connecting", "trouble", "ended"]) {
      expect(mayHide({ ...live, phase })).toBe(false);
      expect(mayAutoHide({ ...live, phase })).toBe(false);
    }
  });

  it("waits while a sheet is open or a button has keyboard focus", () => {
    expect(mayAutoHide({ ...live, sheetOpen: true })).toBe(false);
    expect(mayHide({ ...live, sheetOpen: true })).toBe(false);
    expect(mayAutoHide({ ...live, keyboardFocus: true })).toBe(false);
    expect(mayHide({ ...live, keyboardFocus: true })).toBe(false);
  });

  it("does not hide by itself on a weak link, but a tap still can", () => {
    expect(isWeakTier("good")).toBe(false);
    expect(isWeakTier("ok")).toBe(false);
    expect(isWeakTier("weak")).toBe(true);
    expect(isWeakTier("very-weak")).toBe(true);
    expect(mayAutoHide({ ...live, tier: "ok" })).toBe(true);
    expect(mayAutoHide({ ...live, tier: "weak" })).toBe(false);
    expect(mayAutoHide({ ...live, tier: "very-weak" })).toBe(false);
    expect(mayHide({ ...live, tier: "very-weak" })).toBe(true);
  });

  it("gives touch four seconds and an idle cursor three", () => {
    expect(autoHideDelay("touch")).toBe(4_000);
    expect(autoHideDelay("key")).toBe(4_000);
    expect(autoHideDelay("mouse")).toBe(3_000);
  });
});

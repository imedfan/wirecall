import { describe, expect, it } from "vitest";
import { profileFor, TIER_ORDER, TIER_PROFILES } from "../../src/shared/adaptive";
import { gridLayout, type Rect } from "../../src/shared/grid";

const desktop: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const phone: Rect = { x: 6, y: 50, width: 381, height: 760 };

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width - 0.01 && b.x < a.x + a.width - 0.01 && a.y < b.y + b.height - 0.01 && b.y < a.y + a.height - 0.01;
}

describe("conference grid", () => {
  it("gives every picture an equal tile inside the area, with none overlapping", () => {
    for (const area of [desktop, phone]) {
      for (let count = 1; count <= 6; count += 1) {
        const tiles = gridLayout(area, count, 6);
        expect(tiles).toHaveLength(count);
        for (const tile of tiles) {
          expect(tile.width).toBeCloseTo(tiles[0]!.width);
          expect(tile.height).toBeCloseTo(tiles[0]!.height);
          expect(tile.x).toBeGreaterThanOrEqual(area.x - 0.01);
          expect(tile.y).toBeGreaterThanOrEqual(area.y - 0.01);
          expect(tile.x + tile.width).toBeLessThanOrEqual(area.x + area.width + 0.01);
          expect(tile.y + tile.height).toBeLessThanOrEqual(area.y + area.height + 0.01);
        }
        for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) expect(overlap(tiles[i]!, tiles[j]!)).toBe(false);
      }
    }
  });

  it("makes wide tiles on a wide screen and upright ones on a phone held upright", () => {
    const wide = gridLayout(desktop, 3, 6);
    // Two on top, the third centred under them.
    expect(wide[0]!.y).toBe(wide[1]!.y);
    expect(wide[2]!.y).toBeGreaterThan(wide[0]!.y);
    expect(wide[2]!.x + wide[2]!.width / 2).toBeCloseTo(desktop.width / 2);
    expect(wide[0]!.width).toBeGreaterThan(wide[0]!.height);
    // On a phone the tiles stand upright, like the pictures phones send.
    const tall = gridLayout(phone, 3, 6);
    expect(tall[0]!.height).toBeGreaterThan(tall[0]!.width);
    expect(tall[2]!.x + tall[2]!.width / 2).toBeCloseTo(phone.x + phone.width / 2);
    // Six on a phone: two columns of three.
    const six = gridLayout(phone, 6, 6);
    expect(new Set(six.map((tile) => Math.round(tile.x))).size).toBe(2);
    expect(new Set(six.map((tile) => Math.round(tile.y))).size).toBe(3);
    expect(gridLayout(desktop, 0)).toEqual([]);
    expect(gridLayout({ x: 0, y: 0, width: 0, height: 100 }, 3)).toEqual([]);
  });
});

describe("video limits in a conference", () => {
  it("leaves a call for two as it was and shares the uplink when there are more people", () => {
    for (const tier of TIER_ORDER) {
      expect(profileFor(tier, 0)).toEqual(TIER_PROFILES[tier]);
      expect(profileFor(tier, 1)).toEqual(TIER_PROFILES[tier]);
      let last = Number.POSITIVE_INFINITY;
      for (let remotes = 2; remotes <= 5; remotes += 1) {
        const profile = profileFor(tier, remotes);
        // Never more than the tier allows, never a larger frame than a grid tile needs, and the frame rate is the tier's own.
        expect(profile.maxBitrate).toBeLessThanOrEqual(TIER_PROFILES[tier].maxBitrate);
        expect(profile.maxBitrate).toBeLessThanOrEqual(last);
        expect(profile.targetHeight).toBeLessThanOrEqual(360);
        expect(profile.maxFramerate).toBe(TIER_PROFILES[tier].maxFramerate);
        last = profile.maxBitrate;
      }
    }
    // Five outgoing videos on a good link stay under two megabits together.
    expect(profileFor("good", 5).maxBitrate * 5).toBeLessThan(2_000_000);
  });
});

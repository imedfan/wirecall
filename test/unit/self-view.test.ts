import { describe, expect, it } from "vitest";
import { clampToBox, cornerPosition, CORNERS, defaultCorner, isPhone, nearestCorner, parseCorner, safeBox, selfSize, type Box } from "../../src/shared/self-view";

const phone = { width: 393, height: 852 };
const desktop = { width: 1440, height: 900 };
const notch = { top: 47, right: 0, bottom: 34, left: 0 };

describe("self view size", () => {
  it("is a small upright rectangle on a phone and a wide one on a desktop", () => {
    expect(isPhone(phone)).toBe(true);
    expect(isPhone(desktop)).toBe(false);
    const small = selfSize(phone, 720 / 1280);
    expect(small.width).toBeGreaterThanOrEqual(96);
    expect(small.width).toBeLessThanOrEqual(120);
    expect(small.height).toBeGreaterThan(small.width);
    const large = selfSize(desktop, 1280 / 720);
    expect(large.width).toBeGreaterThanOrEqual(220);
    expect(large.width).toBeLessThanOrEqual(280);
    expect(large.width).toBeGreaterThan(large.height);
  });

  it("keeps the proportions of the camera picture, so the face is not cropped", () => {
    const upright = selfSize(phone, 720 / 1280);
    expect(upright.width / upright.height).toBeCloseTo(720 / 1280, 1);
    const wide = selfSize(desktop, 4 / 3);
    expect(wide.width / wide.height).toBeCloseTo(4 / 3, 1);
    // Before the camera reports a size there is still a sensible window.
    expect(selfSize(phone, undefined).height).toBeGreaterThan(selfSize(phone, undefined).width);
    expect(selfSize(desktop, 0).width).toBeGreaterThan(selfSize(desktop, 0).height);
  });

  it("stays modest on a phone held sideways", () => {
    const sideways = { width: 852, height: 393 };
    const size = selfSize(sideways, 1280 / 720);
    expect(size.height).toBeLessThanOrEqual(393 * 0.45);
    expect(size.width).toBeGreaterThan(size.height);
  });
});

describe("self view corners", () => {
  const size = { width: 108, height: 192 };
  const area = safeBox(phone, notch, 12);

  it("leaves the notch, the home bar and a margin free", () => {
    expect(area).toEqual({ left: 12, top: 59, right: 381, bottom: 806 });
    const sideways = safeBox({ width: 852, height: 393 }, { top: 0, right: 47, bottom: 21, left: 47 }, 12);
    expect(sideways).toEqual({ left: 59, top: 12, right: 793, bottom: 360 });
    for (const corner of CORNERS) {
      const at = cornerPosition(corner, sideways, { width: 192, height: 108 });
      expect(at.x).toBeGreaterThanOrEqual(sideways.left);
      expect(at.x + 192).toBeLessThanOrEqual(sideways.right);
      expect(at.y).toBeGreaterThanOrEqual(sideways.top);
      expect(at.y + 108).toBeLessThanOrEqual(sideways.bottom);
    }
  });

  it("puts the window in each corner of the safe area", () => {
    expect(cornerPosition("top-left", area, size)).toEqual({ x: 12, y: 59 });
    expect(cornerPosition("top-right", area, size)).toEqual({ x: 273, y: 59 });
    expect(cornerPosition("bottom-left", area, size)).toEqual({ x: 12, y: 614 });
    expect(cornerPosition("bottom-right", area, size)).toEqual({ x: 273, y: 614 });
  });

  it("moves away from the button panel and the badge, and comes back when they hide", () => {
    const panel: Box = { left: 16, top: 730, right: 377, bottom: 802 };
    const badge: Box = { left: 12, top: 59, right: 200, bottom: 99 };
    const shown = cornerPosition("bottom-right", area, size, [panel, badge], 12);
    expect(shown.y + size.height).toBeLessThanOrEqual(panel.top - 12);
    expect(shown.x).toBe(273);
    expect(cornerPosition("bottom-right", area, size, [], 12)).toEqual({ x: 273, y: 614 });
    // The badge is on the left only: the right corner keeps its place, the left one steps under the badge.
    expect(cornerPosition("top-right", area, size, [panel, badge], 12)).toEqual({ x: 273, y: 59 });
    expect(cornerPosition("top-left", area, size, [panel, badge], 12)).toEqual({ x: 12, y: 111 });
    // A panel that does not reach the corner, as on a wide desktop, moves nothing.
    const wideArea = safeBox(desktop, { top: 0, right: 0, bottom: 0, left: 0 }, 20);
    const bar: Box = { left: 560, top: 800, right: 880, bottom: 872 };
    expect(cornerPosition("bottom-right", wideArea, { width: 259, height: 146 }, [bar], 12)).toEqual({ x: 1161, y: 734 });
  });

  it("snaps to the nearest corner from wherever the window is let go", () => {
    expect(nearestCorner({ x: 30, y: 80 }, area, size)).toBe("top-left");
    expect(nearestCorner({ x: 250, y: 100 }, area, size)).toBe("top-right");
    expect(nearestCorner({ x: 40, y: 500 }, area, size)).toBe("bottom-left");
    expect(nearestCorner({ x: 260, y: 600 }, area, size)).toBe("bottom-right");
    // The middle of the screen is closer to the top for a window measured by its top-left point.
    expect(nearestCorner({ x: 140, y: 300 }, area, size)).toBe("top-left");
  });

  it("never lets a dragged window leave the safe area", () => {
    expect(clampToBox({ x: -200, y: -200 }, area, size)).toEqual({ x: 12, y: 59 });
    expect(clampToBox({ x: 5_000, y: 5_000 }, area, size)).toEqual({ x: 273, y: 614 });
    expect(clampToBox({ x: 100, y: 300 }, area, size)).toEqual({ x: 100, y: 300 });
    // A box smaller than the window does not produce a negative range.
    expect(clampToBox({ x: 50, y: 50 }, { left: 10, top: 10, right: 60, bottom: 60 }, size)).toEqual({ x: 10, y: 10 });
  });

  it("remembers only a corner name and falls back on anything else", () => {
    expect(defaultCorner(phone)).toBe("top-right");
    expect(defaultCorner(desktop)).toBe("bottom-right");
    expect(parseCorner("bottom-left", "top-right")).toBe("bottom-left");
    expect(parseCorner("middle", "top-right")).toBe("top-right");
    expect(parseCorner(null, "bottom-right")).toBe("bottom-right");
  });
});

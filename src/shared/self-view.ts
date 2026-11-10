/**
 * Geometry of the small «me» window on the call screen. Pure numbers in CSS pixels, no DOM:
 * the view measures the screen and the panels, these functions decide where the window may sit.
 */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
/** Holds one of the four corner names and nothing else: no room, no person. */
export const CORNER_STORAGE_KEY = "wirecall-self-corner";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const PHONE_SHORT_SIDE = 600;
const PHONE_WINDOW = 108;
const WIDEST = 16 / 9;

export function isPhone(viewport: Size): boolean {
  return Math.min(viewport.width, viewport.height) < PHONE_SHORT_SIDE;
}

/** Top right on a phone, away from the thumb and the badge. Bottom right on a desktop, as in every call app. */
export function defaultCorner(viewport: Size): Corner {
  return isPhone(viewport) ? "top-right" : "bottom-right";
}

export function parseCorner(value: unknown, fallback: Corner): Corner {
  return CORNERS.find((corner) => corner === value) ?? fallback;
}

/**
 * The window takes the proportions of the camera picture, so a face is never cropped out of it.
 * A phone gets about 108 px on the short side, a desktop 220 to 280 px on the long one.
 */
export function selfSize(viewport: Size, ratio: number | undefined): Size {
  const phone = isPhone(viewport);
  const known = ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? ratio : phone ? 3 / 4 : WIDEST;
  const wide = known >= 1;
  const stretch = Math.min(WIDEST, wide ? known : 1 / known);
  let short: number;
  let long: number;
  if (phone) {
    short = PHONE_WINDOW;
    long = Math.round(short * stretch);
  } else {
    long = Math.round(Math.min(280, Math.max(220, viewport.width * 0.18)));
    short = Math.round(long / stretch);
  }
  // On a very low screen the window still leaves most of the height to the other person.
  const tallest = Math.max(72, Math.floor(viewport.height * 0.45));
  const height = wide ? short : long;
  const shrink = height > tallest ? tallest / height : 1;
  return {
    width: Math.round((wide ? long : short) * shrink),
    height: Math.round(height * shrink),
  };
}

/** The part of the screen the window may use: inside the notch, the home bar and a margin. */
export function safeBox(viewport: Size, insets: Insets, margin: number): Box {
  return {
    left: insets.left + margin,
    top: insets.top + margin,
    right: viewport.width - insets.right - margin,
    bottom: viewport.height - insets.bottom - margin,
  };
}

/** Keeps the whole window inside the box. A box smaller than the window pins it to the top left. */
export function clampToBox(point: Point, area: Box, size: Size): Point {
  const maxX = Math.max(area.left, area.right - size.width);
  const maxY = Math.max(area.top, area.bottom - size.height);
  return {
    x: Math.min(maxX, Math.max(area.left, point.x)),
    y: Math.min(maxY, Math.max(area.top, point.y)),
  };
}

/**
 * Where the window sits in a corner. A panel in the way (the badge at the top, the buttons at the bottom)
 * pushes it along the edge, down from a top corner and up from a bottom one, never sideways.
 */
export function cornerPosition(corner: Corner, area: Box, size: Size, obstacles: readonly Box[] = [], gap = 0): Point {
  const top = corner === "top-left" || corner === "top-right";
  const left = corner === "top-left" || corner === "bottom-left";
  const x = left ? area.left : area.right - size.width;
  let y = top ? area.top : area.bottom - size.height;
  // Each pass can only move the window further from its edge, so two passes settle any pair of panels.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const obstacle of obstacles) {
      const overlapsX = x < obstacle.right + gap && x + size.width > obstacle.left - gap;
      const overlapsY = y < obstacle.bottom + gap && y + size.height > obstacle.top - gap;
      if (!overlapsX || !overlapsY) continue;
      y = top ? obstacle.bottom + gap : obstacle.top - gap - size.height;
    }
  }
  return clampToBox({ x, y }, area, size);
}

/** The corner whose resting place is closest to where the window was let go. */
export function nearestCorner(point: Point, area: Box, size: Size): Corner {
  let best: Corner = "top-left";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const corner of CORNERS) {
    const rest = cornerPosition(corner, area, size);
    const distance = (rest.x - point.x) ** 2 + (rest.y - point.y) ** 2;
    if (distance < bestDistance) {
      best = corner;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * swipe.ts — pure swipe geometry. No imports, so it unit-tests with no adb.
 *
 * Direction is the way the FINGER moves: `left` goes right-to-left (it advances a
 * left-to-right pager), `up` goes bottom-to-top (it scrolls a list's content down).
 * It is physical and never mirrored by an RTL layout.
 */

export type Direction = "left" | "right" | "up" | "down";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SwipePlan {
  from: Point;
  to: Point;
  durationMs: number;
}

/** Share of each display edge that is kept clear: the system back gesture, the home bar
 * and the notification shade all live in that margin. */
export const EDGE_INSET = 0.1;
/** Shortest travel worth sending, so a tiny region still swipes instead of tapping. */
export const MIN_TRAVEL_PX = 120;
export const DEFAULT_DISTANCE = 0.6;
export const MIN_DURATION_MS = 100;
export const MAX_DURATION_MS = 2000;
/** Default speed ceiling: slower than this is a swipe, faster starts to fling. */
const DEFAULT_PX_PER_MS = 2.5;
const DEFAULT_MIN_DURATION_MS = 300;
/** Under this travel a long duration risks a long-press, so the duration is capped. */
const SHORT_TRAVEL_PX = 200;
const SHORT_TRAVEL_MAX_DURATION_MS = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function intersect(a: Rect, b: Rect): Rect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

/**
 * Start and end points for a swipe of `direction` inside `region`.
 *
 * Symmetric about the region's centre along the swipe axis, with the cross axis at the
 * centre; then every point is clamped to the display's inner box so it stays clear of the
 * system gesture margins. `distance` is a fraction of the region's extent on the swipe axis.
 */
export function swipeGeometry(
  region: Rect,
  display: { width: number; height: number },
  direction: Direction,
  distance: number = DEFAULT_DISTANCE,
  durationMs?: number,
): SwipePlan {
  const screen: Rect = { left: 0, top: 0, right: display.width, bottom: display.height };
  const r = intersect(region, screen);
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  if (w <= 0 || h <= 0) {
    throw new Error(
      "The region is off-screen (it has no area inside the display). " +
        "Scroll it into view first, or omit the selector for a whole-display swipe.",
    );
  }

  const horizontal = direction === "left" || direction === "right";
  const extent = horizontal ? w : h;
  const travel = Math.max(Math.min(MIN_TRAVEL_PX, 0.9 * extent), distance * extent);
  const half = travel / 2;
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;

  // `left` and `up` move the finger toward lower coordinates; `right` and `down` the reverse.
  const sign = direction === "left" || direction === "up" ? 1 : -1;
  const raw: { from: Point; to: Point } = horizontal
    ? { from: { x: cx + sign * half, y: cy }, to: { x: cx - sign * half, y: cy } }
    : { from: { x: cx, y: cy + sign * half }, to: { x: cx, y: cy - sign * half } };

  const inner: Rect = {
    left: display.width * EDGE_INSET,
    top: display.height * EDGE_INSET,
    right: display.width * (1 - EDGE_INSET),
    bottom: display.height * (1 - EDGE_INSET),
  };
  // Points are kept inside the region AND clear of the gesture margins, so a swipe scoped to
  // an element never starts or ends outside that element. For the whole display this is just
  // the inner box.
  const box = intersect(r, inner);
  if (box.right - box.left <= 0 || box.bottom - box.top <= 0) {
    throw new Error(
      "The region lies inside the display's system-gesture margin (the outer " +
        `${EDGE_INSET * 100}% of each edge), where a swipe would trigger back, home or the ` +
        "notification shade instead. Scroll it toward the middle of the screen first.",
    );
  }
  const fit = (p: Point): Point => ({
    x: Math.round(clamp(p.x, box.left, box.right)),
    y: Math.round(clamp(p.y, box.top, box.bottom)),
  });
  const from = fit(raw.from);
  const to = fit(raw.to);

  const travelPx = Math.hypot(to.x - from.x, to.y - from.y);
  if (travelPx === 0) {
    throw new Error(
      "The swipe has no length after fitting it inside the display margins, so it would be " +
        "a tap. The region is too small or too close to the screen edge.",
    );
  }

  let ms =
    durationMs === undefined
      ? Math.max(DEFAULT_MIN_DURATION_MS, Math.round(travelPx / DEFAULT_PX_PER_MS))
      : clamp(Math.round(durationMs), MIN_DURATION_MS, MAX_DURATION_MS);
  if (travelPx < SHORT_TRAVEL_PX) ms = Math.min(ms, SHORT_TRAVEL_MAX_DURATION_MS);

  return { from, to, durationMs: ms };
}

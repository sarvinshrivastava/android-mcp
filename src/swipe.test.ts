import { describe, expect, test } from "bun:test";
import { swipeGeometry, type Rect } from "./swipe.js";

const PORTRAIT = { width: 1080, height: 2400 };
const LANDSCAPE = { width: 2400, height: 1080 };
const whole = (d: { width: number; height: number }): Rect => ({
  left: 0,
  top: 0,
  right: d.width,
  bottom: d.height,
});

describe("directions are the way the finger moves", () => {
  test("left goes right-to-left at the vertical centre", () => {
    const p = swipeGeometry(whole(PORTRAIT), PORTRAIT, "left");
    expect(p.from).toEqual({ x: 864, y: 1200 });
    expect(p.to).toEqual({ x: 216, y: 1200 });
  });

  test("right is the reverse of left", () => {
    const p = swipeGeometry(whole(PORTRAIT), PORTRAIT, "right");
    expect(p.from).toEqual({ x: 216, y: 1200 });
    expect(p.to).toEqual({ x: 864, y: 1200 });
  });

  test("up goes bottom-to-top at the horizontal centre", () => {
    const p = swipeGeometry(whole(PORTRAIT), PORTRAIT, "up");
    expect(p.from).toEqual({ x: 540, y: 1920 });
    expect(p.to).toEqual({ x: 540, y: 480 });
  });

  test("down is the reverse of up", () => {
    const p = swipeGeometry(whole(PORTRAIT), PORTRAIT, "down");
    expect(p.from).toEqual({ x: 540, y: 480 });
    expect(p.to).toEqual({ x: 540, y: 1920 });
  });
});

describe("geometry", () => {
  test("start and end are symmetric about the region centre", () => {
    const region: Rect = { left: 100, top: 500, right: 700, bottom: 900 };
    const p = swipeGeometry(region, PORTRAIT, "left", 0.5);
    expect((p.from.x + p.to.x) / 2).toBe(400);
    expect(p.from.y).toBe(700);
    expect(p.to.y).toBe(700);
    expect(p.from.x - p.to.x).toBe(300);
  });

  test("distance 0.8 over the whole display ends exactly on the 10% margin", () => {
    const p = swipeGeometry(whole(PORTRAIT), PORTRAIT, "left", 0.8);
    expect(p.from.x).toBe(972);
    expect(p.to.x).toBe(108);
  });

  test("a region that reaches the display edge is pulled inside the margin", () => {
    const edge: Rect = { left: 0, top: 1000, right: 400, bottom: 1400 };
    const p = swipeGeometry(edge, PORTRAIT, "right", 0.8);
    expect(p.from.x).toBeGreaterThanOrEqual(108);
    expect(p.to.x).toBeLessThanOrEqual(972);
  });

  test("an element partly off the display is intersected with it", () => {
    const partly: Rect = { left: -300, top: 0, right: 780, bottom: 2400 };
    const p = swipeGeometry(partly, PORTRAIT, "left", 0.5);
    // visible part is x 0..780, centre 390
    expect((p.from.x + p.to.x) / 2).toBe(390);
  });

  test("an element wider than the display is intersected with it", () => {
    const wide: Rect = { left: -500, top: 0, right: 2000, bottom: 2400 };
    const p = swipeGeometry(wide, PORTRAIT, "left");
    expect((p.from.x + p.to.x) / 2).toBe(540);
  });

  test("an element fully off the display fails clearly", () => {
    const off: Rect = { left: 1200, top: 0, right: 2000, bottom: 2400 };
    expect(() => swipeGeometry(off, PORTRAIT, "left")).toThrow(/off-screen/);
  });

  test("all four coordinates are integers", () => {
    const odd: Rect = { left: 3, top: 7, right: 1001, bottom: 2333 };
    for (const d of ["left", "right", "up", "down"] as const) {
      const p = swipeGeometry(odd, PORTRAIT, d, 0.37);
      for (const n of [p.from.x, p.from.y, p.to.x, p.to.y]) {
        expect(Number.isInteger(n)).toBe(true);
      }
    }
  });

  test("landscape uses the landscape dimensions and stays on screen", () => {
    const p = swipeGeometry(whole(LANDSCAPE), LANDSCAPE, "left");
    expect(p.from.y).toBe(540);
    expect(p.to.y).toBe(540);
    expect(p.from.x).toBeLessThanOrEqual(2160);
    expect(p.to.x).toBeGreaterThanOrEqual(240);
    expect(p.from.x - p.to.x).toBe(1440);
  });
});

describe("tiny regions", () => {
  const tiny: Rect = { left: 520, top: 1180, right: 560, bottom: 1220 };

  test("travel is at least 0.9 of a tiny extent, and the swipe is not a tap", () => {
    const p = swipeGeometry(tiny, PORTRAIT, "left");
    expect(p.from.x - p.to.x).toBeGreaterThan(30);
  });

  test("a short travel caps the duration so it cannot become a long-press", () => {
    const p = swipeGeometry(tiny, PORTRAIT, "left", 0.6, 2000);
    expect(p.durationMs).toBe(400);
  });

  test("a sliver pinned to the display edge has no length after fitting and throws", () => {
    const sliver: Rect = { left: 0, top: 1000, right: 1, bottom: 1400 };
    expect(() => swipeGeometry(sliver, PORTRAIT, "left")).toThrow(/no length/);
  });
});

describe("duration", () => {
  test("default is 300 ms for a typical swipe", () => {
    expect(swipeGeometry(whole(PORTRAIT), PORTRAIT, "left").durationMs).toBe(300);
  });

  test("default grows with a long travel to stay below fling speed", () => {
    // 1920 px / 2.5 = 768 ms
    expect(
      swipeGeometry(whole(LANDSCAPE), LANDSCAPE, "left", 0.8).durationMs,
    ).toBe(768);
  });

  test("an explicit duration is clamped to 100-2000 ms", () => {
    expect(swipeGeometry(whole(PORTRAIT), PORTRAIT, "left", 0.6, 50).durationMs).toBe(100);
    expect(swipeGeometry(whole(PORTRAIT), PORTRAIT, "left", 0.6, 5000).durationMs).toBe(2000);
    expect(swipeGeometry(whole(PORTRAIT), PORTRAIT, "left", 0.6, 450).durationMs).toBe(450);
  });
});

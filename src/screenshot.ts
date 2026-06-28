/**
 * screenshot.ts — single-viewport capture and full-page (multi-frame) capture.
 *
 * Android screens have no single scrollable document to grab in one shot. We
 * previously tried to scroll-and-STITCH the frames into one tall PNG, but pixel
 * stitching is fragile: floating FABs, sticky nav bars, dark low-contrast lists,
 * autoplaying media, and transient notifications all corrupt the seam.
 *
 * New approach (deliberate): DON'T stitch. Scroll to the bottom and return the
 * sequence of full-frame screenshots. Overlap and repetition between frames are
 * harmless — only MISSING content hurts. The only thing we measure is a coarse
 * "did the screen move at all?" to know when to stop. That coarse check is robust
 * where precise delta measurement was not.
 */

import sharp from "sharp";
import { adbBinary, getScreenSize } from "./adb.js";
import { shell } from "./adb.js";
import { snapshot } from "./uitree.js";

/** Capture the current viewport as PNG bytes. */
export async function captureViewport(): Promise<Buffer> {
  // exec-out (not `shell`) so the PNG stream isn't corrupted by newline xlat.
  return adbBinary(["exec-out", "screencap", "-p"]);
}

/** Actual pixel dimensions of a captured PNG — correct even when the app is
 * landscape (where `wm size` would report the swapped, physical-portrait dims). */
export async function pngSize(
  buf: Buffer,
): Promise<{ width: number; height: number }> {
  const m = await sharp(buf).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/** Swipe up to scroll the content downward by roughly `fraction` of the height. */
async function scrollDown(fraction: number): Promise<void> {
  const { width, height } = await getScreenSize();
  const x = Math.round(width / 2);
  const yStart = Math.round(height * 0.8);
  const yEnd = Math.round(height * (0.8 - fraction));
  // 400ms swipe — slow enough to avoid fling/momentum overshoot.
  await shell(`input swipe ${x} ${yStart} ${x} ${yEnd} 400`);
  await Bun.sleep(450); // let the scroll settle before capturing
}

/**
 * Coarse "did anything change between two frames" measure: mean absolute
 * grayscale difference over a subsampled grid. Static screens score ~0-3; any
 * real scroll moves enough pixels to score well above the threshold, even on
 * dark, low-contrast UIs. We only need a yes/no, not a precise delta.
 */
async function frameMeanDiff(a: Buffer, b: Buffer): Promise<number> {
  const [ga, gb] = await Promise.all([
    sharp(a).grayscale().raw().toBuffer(),
    sharp(b).grayscale().raw().toBuffer(),
  ]);
  const n = Math.min(ga.length, gb.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 37) {
    // stride 37 ≈ a sparse, evenly-spread sample
    sum += Math.abs(ga[i] - gb[i]);
    count++;
  }
  return count ? sum / count : 0;
}

export interface FullPageResult {
  /** Each viewport frame, top-to-bottom, as PNG bytes. Frames overlap — by design. */
  frames: Buffer[];
  /** True if we stopped because the content ended (real bottom), not the frame cap. */
  reachedBottom: boolean;
  /** How "bottom" was decided: "tree" (no new element labels) or "pixel" (no visual change). */
  detection: "tree" | "pixel";
}

/**
 * Capture a scrollable screen as a SEQUENCE of overlapping viewport frames
 * (no stitching). Over-capture is acceptable; under-capture is not.
 *
 * Bottom detection is TREE-BASED when possible: after each scroll we re-read the
 * accessibility tree and stop when no NEW element labels appeared. That is immune
 * to autoplaying video (pixels change but no new content) — where the old pixel
 * check would run forever. On sparse/canvas screens (no usable tree) we fall back
 * to the coarse pixel "did it move?" check.
 *
 * @param maxFrames safety cap so infinite-scroll screens terminate.
 */
export async function fullPageScreenshot(
  maxFrames = 12,
): Promise<FullPageResult> {
  const MOVE_THRESHOLD = 6; // mean-gray-diff below this ⇒ nothing scrolled
  const frames: Buffer[] = [];
  let prev = await captureViewport();
  frames.push(prev);

  // Seed the seen-labels set for tree-based bottom detection.
  const seen = new Set<string>();
  let firstSnap = null;
  try {
    firstSnap = await snapshot();
  } catch {
    /* tree unavailable */
  }
  firstSnap?.elements.forEach((e) => e.label && seen.add(e.label));
  const useTree = !!firstSnap && !firstSnap.sparse && seen.size > 0;

  let reachedBottom = false;
  for (let i = 1; i < maxFrames; i++) {
    await scrollDown(0.7);
    const next = await captureViewport();

    let moved: boolean;
    if (useTree) {
      let snap = null;
      try {
        snap = await snapshot();
      } catch {
        /* keep snap null → fall through to pixels */
      }
      if (snap && !snap.sparse) {
        const fresh = snap.elements.filter(
          (e) => e.label && !seen.has(e.label),
        );
        moved = fresh.length > 0;
        fresh.forEach((e) => seen.add(e.label));
      } else {
        // Tree vanished mid-scroll (e.g. a video took over) — judge by pixels.
        moved = (await frameMeanDiff(prev, next)) >= MOVE_THRESHOLD;
      }
    } else {
      moved = (await frameMeanDiff(prev, next)) >= MOVE_THRESHOLD;
    }

    if (!moved) {
      // No new content ⇒ bottom. Skip the near-duplicate final frame.
      reachedBottom = true;
      break;
    }
    frames.push(next);
    prev = next;
  }

  return { frames, reachedBottom, detection: useTree ? "tree" : "pixel" };
}

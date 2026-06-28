/**
 * actions.ts — semantic, element-aware interactions.
 *
 * This is the layer that justifies the whole project. A raw `adb shell input
 * tap 540 1230` forces the caller to FIRST discover the coordinate (screenshot →
 * vision → math), which is the expensive part. Here the caller says
 * tap({ text: "Login" }) and we resolve the coordinate from the UI tree — one
 * cheap, deterministic call instead of a screenshot round-trip.
 *
 * Every locator-based action returns enough context (which tier matched, the
 * resolved point) that a failure tells you WHY, and a sparse-tree result tells
 * the caller to fall back to vision.
 */

import { shell, getScreenSize } from "./adb.js";
import {
  snapshot,
  matchElement,
  type Selector,
  type UiNode,
} from "./uitree.js";

export interface ResolveResult {
  node: UiNode | null;
  sparse: boolean; // tree was canvas-like → caller should use visual fallback
  candidates: number; // how many actionable elements were on screen
}

/** Resolve a selector against the live screen. */
export async function resolve(sel: Selector): Promise<ResolveResult> {
  const snap = await snapshot();
  return {
    node: matchElement(snap, sel),
    sparse: snap.sparse,
    candidates: snap.elements.length,
  };
}

function describeSelector(sel: Selector): string {
  return (
    [
      sel.text && `text="${sel.text}"`,
      sel.id && `id="${sel.id}"`,
      sel.desc && `desc="${sel.desc}"`,
    ]
      .filter(Boolean)
      .join(", ") || "(empty selector)"
  );
}

export class ElementNotFound extends Error {
  constructor(
    public readonly sel: Selector,
    public readonly res: ResolveResult,
  ) {
    super(
      res.sparse
        ? `No accessibility tree on this screen (likely a Flutter/canvas app). ` +
            `Fall back to a screenshot + tap_xy. Selector was ${describeSelector(sel)}.`
        : `Element not found: ${describeSelector(sel)}. ` +
            `${res.candidates} actionable elements are on screen — call inspect_screen to see them.`,
    );
    this.name = "ElementNotFound";
  }
}

/** Tap the element matching the selector. */
export async function tap(
  sel: Selector,
): Promise<{ x: number; y: number; label: string }> {
  const res = await resolve(sel);
  if (!res.node) throw new ElementNotFound(sel, res);
  const { x, y } = res.node.center;
  await shell(`input tap ${x} ${y}`);
  return { x, y, label: res.node.label };
}

/** Low-level escape hatch for canvas apps where the tree is empty. */
export async function tapXY(x: number, y: number): Promise<void> {
  await shell(`input tap ${x} ${y}`);
}

/** Focus an input element, then type into it. Optionally clears existing text first. */
export async function typeInto(
  sel: Selector,
  text: string,
  clearFirst = false,
): Promise<{ label: string }> {
  const res = await resolve(sel);
  if (!res.node) throw new ElementNotFound(sel, res);
  await shell(`input tap ${res.node.center.x} ${res.node.center.y}`);
  await Bun.sleep(150);
  if (clearFirst) {
    // Select-all then delete is the most reliable cross-keyboard clear.
    await shell("input keyevent KEYCODE_MOVE_END");
    for (let i = 0; i < (res.node.label.length || 50); i++) {
      await shell("input keyevent KEYCODE_DEL");
    }
  }
  // adb `input text` needs spaces escaped as %s and can't handle some punctuation.
  const escaped = text.replace(/ /g, "%s");
  await shell(`input text "${escaped}"`);
  return { label: res.node.label };
}

/** Poll until a selector resolves (or timeout). Returns the node, or throws. */
export async function waitFor(
  sel: Selector,
  timeoutMs = 8000,
  intervalMs = 500,
): Promise<UiNode> {
  const deadline = Date.now() + timeoutMs;
  let last: ResolveResult | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await resolve(sel);
    if (last.node) return last.node;
    if (Date.now() >= deadline) break;
    await Bun.sleep(intervalMs);
  }
  throw new ElementNotFound(sel, last!);
}

/**
 * Scroll downward until a selector appears on screen, or we run out of attempts.
 * This is impossible to express as a single adb command — it's a measure/act loop.
 */
export async function scrollUntil(
  sel: Selector,
  maxSwipes = 15,
): Promise<{ found: boolean; swipes: number; node?: UiNode }> {
  const { width, height } = await getScreenSize();
  const x = Math.round(width / 2);

  for (let i = 0; i <= maxSwipes; i++) {
    const res = await resolve(sel);
    if (res.node) return { found: true, swipes: i, node: res.node };
    await shell(
      `input swipe ${x} ${Math.round(height * 0.7)} ${x} ${Math.round(height * 0.3)} 400`,
    );
    await Bun.sleep(350);
  }
  return { found: false, swipes: maxSwipes };
}

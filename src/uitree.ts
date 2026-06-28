/**
 * uitree.ts — the "DOM" engine.
 *
 * `uiautomator dump` gives the system-level accessibility tree for WHATEVER app
 * is on screen — no instrumentation, no debug build, no testIDs required. That's
 * exactly why this approach works on production apps you didn't build.
 *
 * Raw dumps are 5–50 KB of XML with dozens of non-interactive layout nodes. An
 * agent that reads that verbatim burns thousands of tokens per look. So we parse
 * it and emit ONLY nodes that a human could actually act on (clickable, has text,
 * is an input, etc.), each as a compact record with a center point ready to tap.
 */

import { adb, adbBinary } from "./adb.js";

export interface UiNode {
  /** Human-meaningful label: text if present, else content-desc. */
  label: string;
  /** Android resource-id, e.g. "com.app:id/login_button" (often absent in RN). */
  resourceId?: string;
  contentDesc?: string;
  className?: string;
  /** Widget bounds [x1,y1,x2,y2] in device pixels. */
  bounds: [number, number, number, number];
  /** Pre-computed tap target (bounds center) so callers never do the math. */
  center: { x: number; y: number };
  clickable: boolean;
  editable: boolean; // an input field
  scrollable: boolean;
  enabled: boolean;
  /** Logical role after grouping: "button" | "input" | "text" | "image". */
  role?: string;
}

export interface UiSnapshot {
  /** Logical elements after grouping (rows collapsed, roles assigned). */
  elements: UiNode[];
  /** Total nodes in the raw tree — used to detect "sparse" (canvas/Flutter) screens. */
  rawNodeCount: number;
  /** Actionable nodes BEFORE grouping (so callers can see how much L3 collapsed). */
  ungroupedCount: number;
  /** True when the tree is too sparse to be trustworthy → caller should fall back to vision. */
  sparse: boolean;
}

/** Dump the current window's accessibility tree as raw XML. */
async function dumpXml(): Promise<string> {
  // Dump to a file then read it back. The "dump to /dev/tty" trick is unreliable
  // across devices; the file round-trip is boring but works everywhere.
  const tmp = "/sdcard/window_dump.xml";
  const { stdout, stderr, exitCode } = await adb([
    "shell",
    "uiautomator",
    "dump",
    tmp,
  ]);
  if (exitCode !== 0) {
    throw new Error(`uiautomator dump failed: ${stderr || stdout}`);
  }
  const bytes = await adbBinary(["exec-out", "cat", tmp]);
  return bytes.toString("utf-8");
}

const BOUNDS_RE = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

/** Decode the XML entities uiautomator emits, so "Network &amp; internet"
 * becomes "Network & internet" and "Workout Diaries &#128170;" becomes the real
 * emoji — otherwise selectors won't match what the user actually sees. Handles
 * both named entities and numeric refs (decimal &#NNN; and hex &#xHH;). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last: avoid turning "&amp;#39;" into a numeric ref prematurely
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : "";
}

function parseBounds(tag: string): [number, number, number, number] | null {
  const m = tag.match(BOUNDS_RE);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
}

/**
 * Clean up the noise TalkBack/uiautomator bakes into labels:
 *  - "double tap to view Hotlist"  → "view Hotlist"   (action-hint prefix)
 *  - "All filter, , selected"       → "All filter, selected"  (empty segments)
 * The result is still the FULL label (used for matching); callers clip it for
 * display. We strip only pure-noise hints, never real text.
 */
export function cleanLabel(s: string): string {
  return (
    s
      .replace(/\s+/g, " ")
      .replace(/\bdouble[ -]tap(?: and hold)? to /gi, "")
      // TalkBack positional announcements baked into labels, e.g.
      // "Money Tab 2 of 3" → "Money", "Home, Tab, 1 of 3" → "Home".
      .replace(/[,\s]*(tab[,\s]*)?\d+\s+of\s+\d+\s*$/i, "")
      .replace(/(,\s*){2,}/g, ", ") // collapse ", , ," runs
      .replace(/^[\s,]+|[\s,]+$/g, "") // trim stray commas/space at ends
      .trim()
  );
}

/**
 * Parse the XML with a regex over <node .../> tags rather than a full DOM parser.
 * uiautomator output is flat, attribute-only, and well-formed enough that this is
 * both faster and dependency-free. We only keep nodes worth acting on.
 */
export function parseSnapshot(xml: string): UiSnapshot {
  const tags = xml.match(/<node\b[^>]*?\/?>/g) || [];
  const elements: UiNode[] = [];

  for (const tag of tags) {
    const bounds = parseBounds(tag);
    if (!bounds) continue;

    const text = cleanLabel(attr(tag, "text"));
    const desc = cleanLabel(attr(tag, "content-desc"));
    const clickable = attr(tag, "clickable") === "true";
    const editable =
      attr(tag, "class").includes("EditText") ||
      attr(tag, "focusable") === "true";
    const scrollable = attr(tag, "scrollable") === "true";

    const label = text || desc;
    const isActionable = clickable || scrollable || !!label || editable;
    if (!isActionable) continue;

    // Skip zero-area nodes (off-screen / collapsed).
    const [x1, y1, x2, y2] = bounds;
    if (x2 <= x1 || y2 <= y1) continue;

    elements.push({
      label,
      resourceId: attr(tag, "resource-id") || undefined,
      contentDesc: desc || undefined,
      className: attr(tag, "class") || undefined,
      bounds,
      center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) },
      clickable,
      editable: attr(tag, "class").includes("EditText"),
      scrollable,
      enabled: attr(tag, "enabled") !== "false",
    });
  }

  const rawNodeCount = tags.length;
  const ungroupedCount = elements.length;
  const grouped = groupElements(elements);
  // The real "can I drive this by the tree?" signal is whether grouping yielded
  // any usable elements — NOT the raw node count. A game (Call of Duty) reports
  // a few structural wrapper nodes but ZERO actionable elements; that is sparse,
  // and the caller must fall back to screenshot + tap_xy.
  const sparse = grouped.length === 0 || ungroupedCount <= 1;

  return {
    elements: grouped,
    rawNodeCount,
    ungroupedCount,
    sparse,
  };
}

const area = (b: [number, number, number, number]) =>
  (b[2] - b[0]) * (b[3] - b[1]);

/** Does `outer` fully contain `inner`? */
function contains(
  outer: [number, number, number, number],
  inner: [number, number, number, number],
): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}

function roleOf(n: UiNode): string {
  if (n.editable) return "input";
  if (n.clickable) return "button";
  if ((n.className || "").includes("Image")) return "image";
  return "text";
}

/**
 * L3 — collapse the raw node soup into logical elements.
 *
 * A list row arrives as 3–5 nodes (clickable container + icon + title + subtitle).
 * We fold every NON-interactive label into the smallest interactive node (button
 * or input) that geometrically contains it, drop redundant wrapper containers,
 * and keep orphan text on its own. The result is ~1 element per visual row, each
 * with a `role` and a merged, matchable label — far fewer, far clearer targets.
 */
function groupElements(all: UiNode[]): UiNode[] {
  const interactive = all
    .filter((n) => n.clickable || n.editable)
    .sort((a, b) => area(a.bounds) - area(b.bounds)); // smallest first
  const collected = new Map<UiNode, string[]>();
  const orphans: UiNode[] = [];

  for (const n of all) {
    const isText = !!n.label && !n.clickable && !n.editable;
    if (!isText) continue;
    // Attach to the smallest interactive ancestor that contains it.
    const host = interactive.find(
      (h) => h !== n && contains(h.bounds, n.bounds),
    );
    if (host) {
      const arr = collected.get(host) || [];
      arr.push(n.label);
      collected.set(host, arr);
    } else {
      orphans.push(n);
    }
  }

  const out: UiNode[] = [];
  for (const n of interactive) {
    const parts = [n.label, ...(collected.get(n) || [])]
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...new Set(parts)].join(" · ");
    // Drop a label-less wrapper that contains a smaller interactive — the inner
    // one is the real target, so the wrapper is just noise.
    const wrapsAnother =
      !merged &&
      interactive.some((o) => o !== n && contains(n.bounds, o.bounds));
    if (wrapsAnother) continue;

    out.push({ ...n, label: merged, role: roleOf(n) });
  }
  for (const n of orphans) out.push({ ...n, role: roleOf(n) });

  // Reading order: top-to-bottom, then left-to-right.
  return out.sort(
    (a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0],
  );
}

/** Fetch + parse the live screen in one call. */
export async function snapshot(): Promise<UiSnapshot> {
  const xml = await dumpXml();
  return parseSnapshot(xml);
}

export type Selector = {
  text?: string;
  id?: string; // matched against resource-id (suffix match, so "login_button" works)
  desc?: string; // content-desc
  /** Partial/contains match instead of exact. Defaults to true for text/desc. */
  exact?: boolean;
};

/** Find the best matching node for a selector, or null. */
export function matchElement(snap: UiSnapshot, sel: Selector): UiNode | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const matches = snap.elements.filter((el) => {
    if (sel.id) {
      const rid = el.resourceId || "";
      if (!rid.endsWith(sel.id) && rid !== sel.id) return false;
    }
    if (sel.text) {
      const hay = norm(el.label);
      const needle = norm(sel.text);
      if (sel.exact ? hay !== needle : !hay.includes(needle)) return false;
    }
    if (sel.desc) {
      const hay = norm(el.contentDesc || "");
      const needle = norm(sel.desc);
      if (sel.exact ? hay !== needle : !hay.includes(needle)) return false;
    }
    return true;
  });

  if (matches.length === 0) return null;

  // Rank matches so the obviously-intended element wins. An EXACT label/desc
  // match must beat a substring match — otherwise text:"Money" grabs the
  // "Pocket money" contact instead of the "Money" tab. Then prefer clickable.
  //
  // L3 merges a row's labels into "A · B · C", so exact-matching is
  // SEGMENT-aware: text:"Play" exactly matches the "Play" segment of
  // "Play · 388 / 650" and beats the substring hit in "How to play".
  const needle = norm(sel.text || sel.desc || "");
  const segs = (s?: string) =>
    norm(s || "")
      .split(" · ")
      .map((x) => x.trim());
  const isExact = (el: UiNode) =>
    !!needle &&
    (segs(el.label).includes(needle) || segs(el.contentDesc).includes(needle));

  const score = (el: UiNode) => (isExact(el) ? 2 : 0) + (el.clickable ? 1 : 0);

  return [...matches].sort((a, b) => score(b) - score(a))[0];
}

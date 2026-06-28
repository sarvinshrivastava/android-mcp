#!/usr/bin/env bun
/**
 * index.ts — the MCP server. Registers every tool and speaks stdio so it can be
 * dropped straight into Claude Code / any MCP client.
 *
 * Tool-design rule enforced here: a tool exists only if it COMPOSES, LOOPS,
 * CONDENSES, or works SEMANTICALLY on the UI tree. Pure 1:1 adb wrappers
 * (install/uninstall/force-stop/deep-link) are intentionally absent — run those
 * with `adb` directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listDevices,
  setTargetSerial,
  getTargetSerial,
  getScreenSize,
} from "./adb.js";
import { snapshot } from "./uitree.js";
import { captureViewport, fullPageScreenshot, pngSize } from "./screenshot.js";
import {
  tap,
  tapXY,
  typeInto,
  waitFor,
  scrollUntil,
  resolve,
} from "./actions.js";
import { currentActivity, readLogcat, resetApp } from "./device.js";

const OUTPUT_DIR =
  process.env.ANDROID_MCP_OUTPUT_DIR || join(tmpdir(), "android-mcp");

async function saveImage(buf: Buffer, name: string): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, name);
  await writeFile(path, buf);
  return path;
}

/** Clip a label for OUTPUT only — matching still uses the full text server-side.
 * Keeps inspect_screen cheap when apps stuff whole email bodies into one label. */
const MAX_LABEL = 80;
function clip(s?: string): string | undefined {
  if (!s) return s;
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL).trimEnd() + "…" : s;
}

/** Shorthand for a text response. */
function text(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

/** Selector schema shared by every element-aware tool. */
const selectorShape = {
  text: z.string().optional().describe("Visible text / label of the element"),
  id: z
    .string()
    .optional()
    .describe("resource-id (suffix match, e.g. 'login_button')"),
  desc: z.string().optional().describe("content-desc (accessibility label)"),
  exact: z
    .boolean()
    .optional()
    .describe("Exact match instead of contains (default false)"),
};

const server = new McpServer({ name: "android-mcp", version: "0.1.0" });

/* ── Device selection ─────────────────────────────────────────────── */

server.tool(
  "list_devices",
  "List connected Android devices/emulators with their serial, state, and model. Call this first if more than one device may be attached.",
  {},
  async () => {
    const devices = await listDevices();
    return text({ devices, target: getTargetSerial() });
  },
);

server.tool(
  "select_device",
  "Target a specific device by serial for all subsequent commands. Needed only when multiple devices are connected.",
  { serial: z.string().describe("Device serial from list_devices") },
  async ({ serial }) => {
    setTargetSerial(serial);
    return text(`Targeting ${serial}`);
  },
);

/* ── Capture & inspection ─────────────────────────────────────────── */

server.tool(
  "inspect_screen",
  "Return the condensed accessibility tree of the current screen: every actionable element (clickable / input / has text) with its label, resource-id, and pre-computed tap coordinates. Use this instead of a screenshot to decide what to tap — it is far cheaper in tokens. If `sparse` is true, the app is a canvas/Flutter surface and you must fall back to a screenshot + tap_xy.",
  {},
  async () => {
    const snap = await snapshot();
    return text({
      sparse: snap.sparse,
      rawNodeCount: snap.rawNodeCount,
      ungroupedCount: snap.ungroupedCount,
      elementCount: snap.elements.length,
      hint: snap.sparse
        ? "Tree is sparse (likely a game/canvas). Use `screenshot` then `tap_xy`."
        : "Each element is one logical target (rows grouped). Match by text/id/desc, then `tap`.",
      elements: snap.elements.map((e) => ({
        role: e.role,
        label: clip(e.label),
        id: e.resourceId,
        center: e.center,
        scrollable: e.scrollable || undefined,
      })),
    });
  },
);

server.tool(
  "find_element",
  "Check whether an element matching a selector is present on the current screen, returning its bounds and tap point. Returns found=false (not an error) when absent.",
  selectorShape,
  async (sel) => {
    const res = await resolve(sel);
    return text({
      found: !!res.node,
      sparse: res.sparse,
      candidates: res.candidates,
      node: res.node
        ? {
            ...res.node,
            label: clip(res.node.label),
            contentDesc: clip(res.node.contentDesc),
          }
        : null,
    });
  },
);

server.tool(
  "screenshot",
  "Capture the current viewport (one screen) as a PNG saved to disk. Returns the file path and dimensions. Use this for canvas/Flutter apps, or when you genuinely need to SEE the pixels.",
  {
    name: z
      .string()
      .optional()
      .describe("Output filename (default screenshot.png)"),
  },
  async ({ name }) => {
    const png = await captureViewport();
    const path = await saveImage(png, name || "screenshot.png");
    // Dimensions come from the ACTUAL image, not `wm size`, so they're correct
    // for landscape apps (games) where the two disagree. tap_xy uses these.
    const { width, height } = await pngSize(png);
    return text({
      path,
      width,
      height,
      orientation: width > height ? "landscape" : "portrait",
    });
  },
);

server.tool(
  "full_page_screenshot",
  "Capture a whole scrollable screen as a SEQUENCE of overlapping viewport screenshots (NOT stitched into one image). Scrolls to the bottom, saving one PNG per viewport, and stops when the screen stops moving. Frames overlap on purpose — repetition is harmless, missing content is not. Returns the ordered list of file paths. Read the frames in order to see the full screen; for a single screen use `screenshot` instead.",
  {
    name: z
      .string()
      .optional()
      .describe(
        "Base filename (default 'fullpage'); frames get -01, -02, … suffixes",
      ),
    maxFrames: z
      .number()
      .optional()
      .describe("Safety cap on viewports captured (default 12)"),
  },
  async ({ name, maxFrames }) => {
    const result = await fullPageScreenshot(maxFrames ?? 12);
    const base = (name || "fullpage").replace(/\.png$/i, "");
    const paths: string[] = [];
    for (let i = 0; i < result.frames.length; i++) {
      const n = String(i + 1).padStart(2, "0");
      paths.push(await saveImage(result.frames[i], `${base}-${n}.png`));
    }
    return text({
      frameCount: paths.length,
      paths,
      reachedBottom: result.reachedBottom,
      bottomDetectedBy: result.detection,
      note: result.reachedBottom
        ? `Reached the bottom (detected via ${result.detection}). Frames overlap — read them in order top-to-bottom.`
        : `Stopped at the ${maxFrames ?? 12}-frame cap (infinite scroll). Frames overlap; read in order.`,
    });
  },
);

/* ── Element-aware interactions ───────────────────────────────────── */

server.tool(
  "tap",
  "Tap the element matching a selector (by text / resource-id / content-desc). Resolves the coordinate from the UI tree, so you never pass pixels. Throws a descriptive error if no match (and tells you whether the screen was a canvas app).",
  selectorShape,
  async (sel) => {
    const r = await tap(sel);
    return text({ tapped: r.label, at: { x: r.x, y: r.y } });
  },
);

server.tool(
  "tap_xy",
  "Low-level escape hatch: tap raw pixel coordinates. Use ONLY for canvas/Flutter apps where inspect_screen reports sparse=true; otherwise prefer `tap`.",
  {
    x: z.number().describe("X pixel"),
    y: z.number().describe("Y pixel"),
  },
  async ({ x, y }) => {
    await tapXY(x, y);
    return text({ tapped: { x, y } });
  },
);

server.tool(
  "type_into",
  "Focus an input element (by selector) and type text into it. Optionally clears existing content first.",
  {
    ...selectorShape,
    value: z.string().describe("Text to type"),
    clearFirst: z
      .boolean()
      .optional()
      .describe("Clear the field before typing (default false)"),
  },
  async ({ value, clearFirst, ...sel }) => {
    const r = await typeInto(sel, value, clearFirst ?? false);
    return text({ typedInto: r.label, value });
  },
);

server.tool(
  "wait_for",
  "Poll until an element matching the selector appears (or timeout). Use after an action that triggers async navigation/loading. Throws on timeout.",
  {
    ...selectorShape,
    timeoutMs: z.number().optional().describe("Max wait in ms (default 8000)"),
  },
  async ({ timeoutMs, ...sel }) => {
    const node = await waitFor(sel, timeoutMs ?? 8000);
    return text({ appeared: node.label, at: node.center });
  },
);

server.tool(
  "scroll_until",
  "Scroll the screen downward until an element matching the selector becomes visible, or until maxSwipes is exhausted. Impossible as a single adb command — it's a measure-and-act loop.",
  {
    ...selectorShape,
    maxSwipes: z.number().optional().describe("Max scroll steps (default 15)"),
  },
  async ({ maxSwipes, ...sel }) => {
    const r = await scrollUntil(sel, maxSwipes ?? 15);
    return text(r);
  },
);

/* ── Developer & test utilities ───────────────────────────────────── */

server.tool(
  "current_activity",
  "Return the foreground app's package + activity, plus a `screenSignature` and best-guess `screenTitle` derived from the element tree. For single-Activity apps (Compose/RN/Flutter) the activity never changes between screens — compare `screenSignature` across calls to detect navigation.",
  {},
  async () => text(await currentActivity()),
);

server.tool(
  "read_logcat",
  "Read recent device logs, filtered and tailed, with crashes/ANRs auto-flagged. Condenses the logcat firehose into the few lines that matter.",
  {
    filter: z.string().optional().describe("Substring/tag filter"),
    priority: z
      .enum(["V", "D", "I", "W", "E", "F"])
      .optional()
      .describe("Minimum priority (default W)"),
    tail: z.number().optional().describe("Lines to return (default 100)"),
  },
  async (opts) => text(await readLogcat(opts)),
);

server.tool(
  "reset_app",
  "Clear an app's data AND relaunch it — the standard 'fresh first-run' state for a test. Composes two commands into one test concept.",
  { package: z.string().describe("App package, e.g. com.example.app") },
  async ({ package: pkg }) => text(await resetApp(pkg)),
);

/* ── Boot ─────────────────────────────────────────────────────────── */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("android-mcp server running on stdio");

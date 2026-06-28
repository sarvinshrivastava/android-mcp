# android-mcp

**Playwright-style automation for Android devices, exposed as an MCP server.**

Drives _any_ installed app over `adb` — native or React Native, including
production apps you didn't build — without instrumentation, debug builds, or
`testID`s. An AI agent (or any MCP client) gets a small set of high-level,
**element-aware** tools instead of having to remember `adb` syntax or compute
pixel coordinates.

`full_page_screenshot` scrolls a screen to the bottom and returns the **sequence
of overlapping viewport screenshots** (it deliberately does NOT stitch — see the
limits section for why). Overlap is harmless; missing content is not.

---

## Why these tools (and not a wrapper per adb command)

A tool only earns a place here if it does something a raw `adb` one-liner
**can't**:

| Criterion       | Example                                                          |
| --------------- | ---------------------------------------------------------------- |
| **Compose**     | `tap` = dump tree → match element → tap its center               |
| **Loop / state**| `full_page_screenshot`, `scroll_until`, `wait_for`               |
| **Condense**    | `inspect_screen` turns 50 KB of XML into a short element list     |
| **Semantic**    | `tap({text:"Login"})` instead of `tap(540, 1230)`                |

Pure 1:1 wrappers (`install`, `uninstall`, `force-stop`, deep-link, raw
`keyevent`) are **deliberately absent** — just run those with `adb` directly.

### The token argument

`tap(x, y)` doesn't actually save anything: the expensive part is _discovering_
the coordinate (screenshot → vision → math). `tap({text})` resolves the
coordinate from the accessibility tree in one cheap, deterministic call. That is
the whole point of this server.

---

## How it works on _any_ app: a degrading locator

| App type                 | Accessibility tree (`uiautomator`)     | Strategy                          |
| ------------------------ | -------------------------------------- | --------------------------------- |
| Native / **React Native**| Rich & reliable                        | Tier 1 — match by text/id/desc ✅ |
| **Flutter** (production)  | **Rich** — Flutter bridges its Semantics tree to Android a11y (verified on **GPay**) | Tier 1 ✅ |
| **Games / true canvas / a11y-off** | Empty — 0 actionable elements (verified on **Call of Duty**) | `inspect_screen` reports `sparse:true` → `screenshot` + `tap_xy` ✅ verified end-to-end |

**Surprise finding (verified):** the assumption "Flutter ⇒ sparse" is **wrong**
for production apps. GPay (a Flutter app — its activity is literally
`…flutter.gpay.app.MainActivity`) exposed 28 clean elements, fully drivable by
the tree-first locator. Flutter only looks empty when accessibility/Semantics is
off (games, some custom canvases). So `sparse:true` is rare in practice; the
fallback exists but seldom fires.

`inspect_screen` always tells you _which_ situation you're in, so flakiness is
diagnosable, not mysterious.

### Boundaries the tool won't cross (by design)

- **Biometric-gated apps** (GPay, banking): launching drops you on a system
  `BiometricPrompt` that only the user's fingerprint/face can clear. The tool
  cannot (and shouldn't) bypass it.
- **`FLAG_SECURE` screens**: `screencap` returns black and `uiautomator` may be
  blocked. Expected, not a bug. (GPay's home is *not* FLAG_SECURE; many
  banking/DRM screens are.)

### Canvas/game fallback (verified on Call of Duty)

When `inspect_screen` returns `sparse:true` (a game/canvas with no usable tree):
take a `screenshot`, reason on the pixels, and `tap_xy`. `screenshot` reports the
**actual image dimensions** and `orientation` (correct for landscape games, where
`wm size` would report swapped portrait dims), and `input tap` shares the
screenshot's coordinate system — so a pixel you read off the frame taps true,
**no rotation math needed**, even in landscape.

### `full_page_screenshot` returns frames, not a stitched image

An earlier version scroll-and-**stitched** frames into one tall PNG by aligning
them on pixel content. That proved fundamentally fragile — sticky nav bars,
floating FABs (Gmail), dark low-contrast lists (WhatsApp), autoplaying media
(Instagram), and transient notifications all corrupted the seam. It only worked
on a plain list with no floating chrome.

So stitching was **removed**. The tool now scrolls to the bottom and returns the
**ordered list of overlapping viewport PNGs**. Read them in order to see the whole
screen; repetition between frames is harmless, missing content is not.

**Bottom detection is tree-based.** After each scroll we re-read the element tree
and stop when **no new element labels appeared** (`bottomDetectedBy: "tree"`).
This is immune to autoplaying video — pixels keep changing but no new content
arrives, so it stops correctly where a pixel diff would run to `maxFrames`. On
sparse/canvas screens with no usable tree it falls back to the coarse pixel
"did it move?" check (`bottomDetectedBy: "pixel"`).

### `inspect_screen` returns grouped logical elements (L3)

Raw `uiautomator` emits a list row as 3–5 nodes (clickable container + icon +
title + subtitle). `inspect_screen` collapses these by **geometric containment**:
each non-interactive label folds into the smallest interactive node that contains
it, redundant wrappers are dropped, and every element gets a `role`
(`button`/`input`/`text`/`image`). Result on WhatsApp: **75 → 34 elements**, one
per visual row, each with a merged matchable label. `ungroupedCount` reports the
pre-grouping total.

### `current_activity` carries a `screenSignature`

Most modern apps (Compose / React Native / **Flutter** — GPay included) host
every screen in **one Activity**, so the activity name can't tell screens apart.
`current_activity` therefore also returns a `screenSignature` (a hash of the
screen's resource-ids) and a best-guess `screenTitle`. Same activity + different
signature across two calls ⇒ navigation happened. Verified on Gmail and on GPay
(single-Activity Flutter).

### Selector matching prefers exact over substring

Matching is `contains` by default, but an **exact** (case-insensitive) label/desc
match wins over a substring one — so `tap({text:"Money"})` hits the *Money tab*,
not the *Pocket money* contact. Labels are also cleaned of TalkBack noise
(`"double tap to …"`, `"Tab 2 of 3"`) before matching.

---

## Tools

### Capture & inspection

- **`inspect_screen`** — condensed list of actionable elements (label, id,
  pre-computed tap point, flags). Use this _instead of_ a screenshot to decide
  what to tap.
- **`full_page_screenshot`** — scroll-and-stitch the whole screen into one PNG;
  auto-detects the bottom. _(the flagship)_
- **`screenshot`** — single viewport PNG (use for canvas apps or when you need pixels).
- **`find_element`** — is this selector present? returns bounds + tap point.

### Element-aware interactions

- **`tap`** — tap the element matching `{text|id|desc}`.
- **`type_into`** — focus an input and type (optional `clearFirst`).
- **`wait_for`** — poll until an element appears (post-navigation/loading).
- **`scroll_until`** — scroll down until a target element is visible.
- **`tap_xy`** — low-level pixel tap; escape hatch for `sparse` canvas screens.

### Device & test utilities

- **`current_activity`** — foreground package/activity ("which screen am I on?").
- **`read_logcat`** — filtered, tailed logs with crashes/ANRs auto-flagged.
- **`reset_app`** — clear data **and** relaunch (fresh first-run state for tests).
- **`list_devices`** / **`select_device`** — target a device when several are attached.

---

## Setup

```bash
cd ~/codes/other/android-mcp
bun install
```

Requires `adb` on PATH or `ANDROID_HOME` set (the server resolves
`$ANDROID_HOME/platform-tools/adb`). A device/emulator must be connected with
USB debugging on.

### Register with Claude Code

```bash
claude mcp add android -- bun run ~/codes/other/android-mcp/src/index.ts
```

Or add to your MCP config manually:

```json
{
  "mcpServers": {
    "android": {
      "command": "bun",
      "args": ["run", "/Users/habuild/codes/other/android-mcp/src/index.ts"]
    }
  }
}
```

### Environment variables

| Var                      | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `ANDROID_SERIAL`         | Default device (skip `select_device`)               |
| `ADB_PATH`               | Explicit adb binary path                            |
| `ANDROID_MCP_OUTPUT_DIR` | Where screenshots are saved (default `$TMPDIR/android-mcp`) |

Screenshots are written to disk and tools return the **path** (not inline
base64) — a tall full-page PNG would otherwise cost thousands of tokens per call.

---

## Roadmap (v2 — proposed, not yet built)

- **`visual_diff`** — compare a capture against a saved baseline (visual regression).
- **`set_device_state`** — rotate, toggle airplane/wifi, locale, **font scale** (a11y).
- **`dumpsys_perf`** — memory / FPS / battery snapshot for perf checks.
- **OCR visual fallback** — deterministic text→coordinate for Flutter/canvas apps
  (currently the agent's own vision handles this via `screenshot` + `tap_xy`).
- **`record_screen`** — capture a flow as video.
```

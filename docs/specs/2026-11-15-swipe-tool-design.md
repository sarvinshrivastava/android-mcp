# `swipe` tool: spec and plan

## Goal
Let an agent swipe by direction, including horizontally. Today the only gesture is
`scroll_until`, which swipes down only. Horizontal pagers (the Compass app's Compass/Level
pager, carousels, onboarding) cannot be driven, and raw `adb shell input swipe` is forbidden by
the device-testing skill.

## Tool contract
`swipe({ direction, text?, id?, desc?, exact?, distance?, durationMs? })`

- `direction`: `left | right | up | down`. **The direction the finger moves.** Examples:
  `left` advances a left-to-right pager; `up` scrolls a list's content down, revealing later
  items (this is the opposite word to `scroll_until`, which names the content direction).
  Physical, never mirrored by an RTL layout.
- Selector (`text`/`id`/`desc`/`exact`, same shape as every other tool; strings must be
  non-empty): optional. When given, the swipe happens inside the bounds of the matched element.
  The element must be one `inspect_screen` lists, and is used exactly as matched (no ancestor
  lookup), so for a pager pass the container's own id or desc. When absent, the swipe is over
  the whole display.
- `distance`: fraction of the region's extent along the swipe axis, 0.1-0.8 (default 0.6).
- `durationMs`: optional, 100-2000. Default is `max(300, travelPx / 2.5)`, which keeps the
  gesture below fling speed. A short duration over a long distance is a fling.
- Returns `{ direction, region: { kind: "display" | "element", label?, bounds }, display,
  from, to, durationMs }`. `region.bounds` is what was actually used, so a swipe that landed in
  the wrong container is visible. The tool reports that the gesture was sent, not that anything
  moved: check with `screenshot` or `current_activity`.
- After the gesture it waits 350 ms, as `scroll_until` does.

## Why this is a tool, not an `adb` wrapper
The repo's rule is that a tool must compose, loop, condense or work semantically on the UI tree.
This one composes the display geometry and an optional element's bounds into start and end
points, so the caller says `swipe({ direction: "left" })` and never does coordinate maths.

## Geometry
- **Display size** comes from a screen capture's PNG dimensions (`captureViewport` +
  `pngSize`). It is always the current orientation, works on every Android version, needs no UI
  dump, and so works on animating screens and sparse (canvas/game) trees. (`wm size` reports the
  physical portrait size and ignores rotation; `getScreenSize` is left as it is and keeps its
  existing users.)
- **Region:** the matched element's bounds intersected with the display, or the whole display.
  If the intersection has no area, fail with "element is off-screen".
- **Start and end:** symmetric about the region's centre along the swipe axis, cross axis at the
  centre. Every point is then clamped to the inner 80% box of the display (10% in from each
  edge), which keeps clear of the system back gesture, the home bar and the notification shade.
- **Minimum travel:** at least `min(120 px, 0.9 x extent)`. When the travel is under 200 px the
  duration is capped at 400 ms so it cannot turn into a long-press.
- All four coordinates are rounded to integers, and a swipe whose rounded start equals its end
  fails instead of sending a tap.

## Errors
- Selector matches nothing: the same `ElementNotFound` text as `tap`. On a sparse tree the
  message also says "omit the selector for a whole-screen swipe".
- adb failures surface as the tool error, as for every other tool.

## Out of scope (and noted for follow-up)
- A `direction` parameter on `scroll_until`; flings with a velocity argument; multi-finger,
  long-press or drag gestures; absolute-coordinate swipes.
- Unlabeled scrollable containers that `groupElements` drops cannot be selected; use the
  whole-display swipe. Elements partly off the left or top edge are dropped by `BOUNDS_RE`
  (`\d+` rejects negative bounds). `getScreenSize` is wrong in landscape, which affects
  `scroll_until` and `screenshot`. A stale `window_dump.xml` after a failed dump. Concurrent
  calls sharing the dump file. None of these are changed here.

## Acceptance criteria
1. On the Compass app's compass page, `swipe({ direction: "left" })` moves to the Level page and
   `right` moves back.
2. With a selector, both points stay inside that element.
3. In landscape (the Level page) a swipe stays on screen.
4. A selector that matches nothing returns the same text as `tap`; an off-screen element fails
   clearly.
5. `bun run typecheck` and `bun test` pass; the geometry function has unit tests.

## Edge cases (baseline)
1. Offline / flaky network: N/A (adb over USB or a local emulator); an adb failure surfaces as
   the tool error.
2. App backgrounded or killed mid-flow: N/A, stateless gesture.
3. Duplicate submissions: one call is one swipe; no retry loop.
4. Empty / first-run state: a screen with no actionable elements works for a whole-display swipe
   (no UI dump is involved); a selector on a sparse tree returns the sparse-tree message.
5. Zero-length and very large data: tiny element (minimum travel), element larger than the
   display (intersected), `distance` out of range (schema rejects), empty-string selector (schema
   rejects).
6. Permission denied: N/A.
7. Partial failure: the screen capture or the swipe command fails; the error surfaces and no
   gesture is sent after a failed capture.
8. Time zone and dates: N/A.
9. Locale: direction is physical, so RTL layouts do not change it; stated in the tool text.
10. Old app versions: N/A; an additive tool, existing tools are untouched.
11. Analytics: N/A.

## Plan
1. `src/swipe.ts`: pure `swipeGeometry(region, display, direction, distance, durationMs?)`
   returning `{ from, to, durationMs }` or throwing for an empty region or a zero-length swipe;
   no imports, so it can be unit-tested.
2. `src/screenshot.ts`: `getDisplaySize()` (screen capture, `pngSize`), used by `swipe` only (it
   lives there because `adb.ts` cannot import `screenshot.ts` without a cycle).
3. `src/actions.ts`: `swipe(direction, sel?, distance?, durationMs?)`: display size, optional
   element region via `resolve`, `swipeGeometry`, `input swipe x1 y1 x2 y2 ms`, 350 ms settle.
4. `src/index.ts`: register `swipe` next to `scroll_until` (zod: direction enum, non-empty
   selector strings, `distance` 0.1-0.8, `durationMs` 100-2000), with the tool text above.
5. `src/swipe.test.ts` (`bun test`): four directions, symmetry about the centre, the 10% inset
   clamp, element region inside and partly off the display, off-screen element error, tiny
   region minimum travel and the duration cap, rounding and zero-length error, landscape
   dimensions, default duration. `package.json` gets a `test` script.
6. `README.md`: tool table and tool list, with the finger-direction convention.
7. Verify: `bun run typecheck`, `bun test`, then a live run against the Pixel 9a emulator on the
   Compass app (swipe left to the Level page and right back, an element-scoped swipe, landscape
   on the Level page).

Plan gate (1d): skipped. One module, an additive tool, no change to any existing tool's contract.

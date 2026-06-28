# android-mcp — multi-app test report (2026-06-28)

Tested the MCP tool against 7 diverse production apps on a Pixel 9a
(`58111XEBF9WEAF`). Goal: find bugs in the tool and decide long-term changes.
Each app got the same battery: `current_activity` → `inspect_screen` →
`screenshot` → `full_page_screenshot` → `read_logcat`.

> Device note: a single physical device is a **serial** resource (one foreground
> app, one shared `uiautomator` dump file, interleaving input). True parallel
> testing is impossible; apps were run sequentially.

## Results matrix

| App | Activity model | Tree (`sparse`?) | raw→actionable | `full_page` | logcat |
|---|---|---|---|---|---|
| Gmail | ConversationListActivity | rich (no) | 136→65 | ⚠️ scrambled (5 frames) | clean |
| Messages | ConversationListActivity | rich (no) | 134→58 | ⚠️ needs review (3 frames) | clean |
| District | single HomeActivity | rich (no) | 122→36 | 3 frames | clean |
| EatClub | (opened to stale feedback screen) | rich (no) | 47→23 | 3 frames | clean |
| Notion | single MainActivity | rich (no) — even in doc editor | 152→47 | 3 frames | clean |
| Splitwise | DashboardActivity | rich (no) | 67→30 | ✅ 1 frame (fits screen) | clean |
| YouTube Music | single MusicActivity | rich (no) | 212→64 | 6 frames (tall) | clean |

## What works well (validated across all 7)

- **Tree-first locator is universal.** Every app — native, RN, and custom-render
  (Notion, YT Music) — exposed a rich accessibility tree. `sparse` was never
  true. The semantic `tap`/`find_element`/`type_into` model is sound on real
  production apps we didn't build.
- **`type_into` verified end-to-end** (Gmail Compose → `subject` field → typed →
  read back exactly).
- **`tap` by text/id verified** (Gmail Compose, Notion page open → navigation).
- **`current_activity`** correctly reported even unexpected states (EatClub
  restored to an order-feedback activity).
- **`read_logcat`** — zero crashes/ANRs across all apps; filtering works.
- **Single-frame `full_page`** is correct (Splitwise dashboard genuinely fits one
  screen — clean capture, no duplication).

## Bugs found

### B1 — `full_page_screenshot` multi-frame stitch is broken on chrome-heavy screens — HIGH
Confirmed scrambled on **Gmail** (light theme!): the Compose FAB and bottom nav
bar are duplicated repeatedly down the image, with a status bar floating
mid-page. Matches earlier Instagram (autoplay) and WhatsApp (dark UI) failures.
Root cause is fundamental: **pixel-diff stitching can't cope with floating/sticky
elements, low-contrast repetitive rows, autoplaying media, or transient
overlays.** Only works on a plain list with no floating chrome (Settings) or when
the screen fits one frame.

### B2 — `inspect_screen` label bloat — MEDIUM
Gmail email rows expose the **entire email body** as one `content-desc` (500+
chars each). A 20-row list returns thousands of tokens, partially defeating the
whole "condense the tree" value proposition.

### B3 — sticky-region detection (pixel-based) is unreliable — MEDIUM
`stickyFooter` returned **0** for Gmail despite a clear bottom nav (a notification
badge animates, breaking the identical-row test) and **over-counted** on WhatsApp
(static whitespace counted as footer). Pixel-row comparison is the wrong signal.

### B4 — label quality: TalkBack hints & composite blobs — LOW
- District: action hints leak into labels — `"double tap to open side menu"`.
- Messages/Gmail: verbose composite labels — `"Copy '4707'"`, whole-row concatenations.
  Matching mostly survives via `contains`, but labels are noisy.

### B5 — `sparse`/canvas fallback path is UNVERIFIED — INFO/RISK
No tested app was sparse (even Notion's editor is rich). The Flutter/canvas
fallback has never run against a real app, so its threshold (`rawNodeCount <= 3`)
is untuned. Needs a Flutter app to validate.

### B6 — `current_activity` is coarse on single-Activity apps — LOW
District, Notion, YT Music each host everything in one Activity, so
`current_activity` can't distinguish screens. (Re-confirmed from prior sessions.)

### B7 — "reached bottom" vs "hit cap" is ambiguous — LOW
YT Music returned `frames:6` with `maxFrames:6` and `reachedBottom:true`. When the
two coincide you can't tell a true bottom from a truncated capture.

## Long-term changes (priority order)

### L1 — Replace pixel-stitch with TREE-DRIVEN scrolling — CRITICAL
The fix for B1/B3 and the single biggest win. Since the tree is rich on every
app: before scrolling, record a known element's label + bounds; scroll; re-find
it; the bounds delta is the **exact, noise-free** scroll distance. Sticky chrome =
elements whose bounds don't change. True bottom = scrollable node reports no more
range, or no new element labels appear. Immune to dark themes, autoplay, FABs,
badges. This one change fixes Gmail + WhatsApp + Instagram simultaneously.

### L2 — Label hygiene in `inspect_screen` — HIGH
Fixes B2/B4. Clip returned labels to ~80 chars (keep full text internally for
matching); strip TalkBack action-hint prefixes; prefer `text` over giant
`content-desc` when both exist.

### L3 — Logical-element grouping / roles — MEDIUM
Each list row currently appears as 3–5 nodes (container + icon + title + desc).
Collapse them into one logical element with a `role`, so "76 elements" becomes
~12 meaningful rows. Large token + usability win, and makes `tap` targeting less
ambiguous.

### L4 — Tree-based sticky detection — MEDIUM
Replace pixel-row sticky detection with "which element bounds are identical before
and after a scroll." Robust to animated badges and whitespace (fixes B3).

### L5 — Distinguish bottom vs cap; verify sparse path — MEDIUM
Report `hitFrameCap: true` separately from `reachedBottom` (B7). Test the `sparse`
fallback against a real Flutter app and tune the threshold (B5).

### L6 — Screen fingerprinting for single-Activity apps — LOW
Augment `current_activity` with a hash/signature of the element set so navigation
is detectable in single-Activity apps (B6).

---

## Follow-up: fixes applied + Flutter/GPay results (same day)

Acting on the directives:

| Item | Status | What changed |
|---|---|---|
| **B1** stitch scramble | ✅ FIXED | `full_page_screenshot` no longer stitches — returns the ordered list of overlapping viewport PNGs. Coarse "did it move?" stop-detection. Verified clean on District (6 frames, dark + auto-carousel). |
| **B2** label bloat | ✅ FIXED | Output labels clipped to 80 chars + ellipsis (full text kept server-side for matching). Verified: Gmail longest label 500+ → 81. |
| **B3** sticky detection | ✅ MOOT | Deleted with stitching — no longer needed. |
| **B4** label noise | ✅ FIXED | `cleanLabel` strips `"double tap to …"`, `"Tab N of M"`, and `", ,"` runs. |
| **B5** Flutter/sparse | ✅ TESTED | See below — major finding. |
| **B6** single-Activity nav | ✅ FIXED | `current_activity` now returns `screenSignature` + `screenTitle`. Verified on Gmail and GPay. |
| **B8** (new) selector precedence | ✅ FIXED | Exact (case-insensitive) match now beats substring; `tap("Money")` → Money tab, not "Pocket money". |

### B5 — the headline result: "Flutter ⇒ sparse" is FALSE

Found one already-installed Flutter app via `libflutter.so` scan
(`com.sbi.lotusintouch`) and tested **GPay** (`…flutter.gpay.app.MainActivity`):

- GPay home: **`sparse: false`**, 46 raw nodes → 28 clean elements ("Scan any QR
  code", "Bank transfer", …). Fully drivable by the tree-first locator.
- `screenshot` returned real pixels (no FLAG_SECURE on home).
- Launch hits a **`BiometricPrompt`** the tool can't clear — auth-gated apps need
  the user's finger first.

**Implication:** production Flutter apps bridge their Semantics tree to Android
a11y, so they are NOT sparse. The `sparse` fallback is rarer than assumed —
it only fires on games / true-canvas / accessibility-off surfaces. Remaining gap:
the `sparse` path is still unverified against a genuinely empty-tree app.

### Net status

The full battery (B1–B8) is resolved or consciously deferred. The tree-first
engine is now validated on 11 apps incl. a production Flutter app, with zero
crashes. The only deliberately-unbuilt item is true tree-driven *scrolling* (not
needed now that full-page returns frames), and verifying the `sparse` path on a
real canvas/game app.

---

## Follow-up 2: L3 grouping + tree-based bottom detection

Clarification on "tree-based parsing": **tree-driven *scrolling* (old L1) was never
built and is now unnecessary** — dropping stitching removed the need to measure
scroll distance. But the related, genuinely-missing piece — **tree-based bottom
detection** — is now implemented.

| Change | Status | Verified |
|---|---|---|
| **L3** logical-element grouping (containment-based, roles) | ✅ DONE | WhatsApp **75 → 34** elements (55% fewer); each chat row = 1 `button` with merged label; `tap("Dad")` opened the chat (no regression). |
| **Tree-based bottom detection** in `full_page_screenshot` | ✅ DONE | WhatsApp chat list → 5 frames, `reachedBottom:true`, `bottomDetectedBy:"tree"`. The dark list that broke every pixel approach now works. Falls back to `"pixel"` on sparse screens. |

`inspect_screen` now returns `role` per element + `ungroupedCount`.
`full_page_screenshot` now returns `bottomDetectedBy: "tree" | "pixel"`.

### Still open
- **L3 tuning:** geometric containment can occasionally fold a label into the
  wrong overlapping container; revisit if a real app misgroups.
- **`sparse` path:** still unverified against a true canvas/game app (all tested
  apps, incl. Flutter GPay, expose rich trees).

---

## Follow-up 3: the `sparse` path verified on a real game (Call of Duty)

Tested **Call of Duty Mobile** (`com.tencent.tmgp.cod.CODMainActivity`) — the
first genuine canvas/GL surface in the whole campaign. It found one more bug and
finally exercised (and fixed) the fallback.

| Item | Result |
|---|---|
| `sparse` detection | 🐛→✅ **Bug found & fixed.** CoD = 5 raw nodes but **0 actionable elements**; old heuristic (`rawNodeCount <= 3`) reported `sparse:false`. Fixed to key off the **grouped element count** → now `sparse:true`, hint correctly says "use screenshot + tap_xy", and `tap` throws the canvas-fallback message. |
| screenshot viability | ✅ CoD renders fully (no FLAG_SECURE black-out) — pixels available for the fallback. |
| **B9 orientation dims** | 🐛→✅ **Bug found & fixed.** `screenshot` reported `1080×2424` (from `wm size`) for a landscape `2424×1080` game. Now reports the **actual PNG dimensions** + `orientation`. Critical because tap_xy is the only canvas input. |
| `tap_xy` in landscape | ✅ `tap_xy(1944,117)` (a pixel read off the landscape frame) closed the dialog — **`input tap` shares `screencap`'s coordinate system; no rotation transform needed.** |
| **B8 regression from L3** | 🐛→✅ L3's merged labels broke exact-match (`tap("Play")` hit "How to play"). Fixed: exact-match is now **segment-aware** (splits on " · "). |

**Net:** the `sparse → screenshot → tap_xy` fallback is now proven end-to-end on
a real game. Every core path of the tool has been exercised against production
apps spanning native, RN, Flutter, and GL-canvas, with all discovered bugs fixed.

# FRONTEND_NOTES.md

Decisions made during the overnight frontend session (2026-09-19 into 2026-09-20).
Conservative choice taken whenever something was ambiguous; each one is logged here.

## Copy rules in force

No em dashes, no exclamation marks, no emoji, no "Let's". No UI sentence over 12
words. Numbers carry units. One idea per line. Labels that can be deleted are
deleted.

## Tier 1: typography and title

- **Font discovery.** `sedimentlabs.ai` loads `/assets/index-*.css`, which declares
  three `@font-face` rules for **Selawik** at weights 400, 600 and 700, plus a mono
  stack `ui-monospace, Cascadia Mono, Consolas, Menlo, monospace`.
- **Selawik is freely licensed** (Microsoft, SIL Open Font License 1.1 — it is their
  open metric-compatible replacement for Segoe UI), so it is used directly rather
  than substituted. The three woff2 files are vendored to `web/vendor/fonts/` and
  loaded from there. No CDN, works offline.
- The woff2 files are Sediment's Latin subsets (about 14 KB each). Glyph coverage is
  verified in the headless check; if a glyph were missing the check would catch it
  as a fallback-metrics mismatch.
- Mono stack copied from Sediment as well, replacing the previous JetBrains Mono
  request (which was never vendored and so never actually loaded).
- **Title card**: the word is rendered twice. The back copy is `#ff2a1a`, blurred
  12 px and passed through `feTurbulence` + `feDisplacementMap`; `seed` and
  `baseFrequency` drift under requestAnimationFrame so the red edge waves like heat.
  The white copy carries no filter at all, so it never flickers. The animation stops
  when the card is dismissed.
- **Logo**: one horizontal white line with a clean gap in the middle (the break),
  with the wordmark beside it in Selawik. Same mark as `web/favicon.svg`.
- Panel heading removed: the brand mark top-left is now the only place the product
  names itself.
- **Title card sits on solid black**, not over the map. Over satellite imagery the
  red heat was invisible and the screen was not "nothing else". Black also cuts
  straight into the opening, which starts black.

## Tier 2: cinematic opening

- Enter fades the card, the map starts at zoom 6 (state scale) and flies to the
  region over 10 s with `flyTo({duration: 10, easeLinearity: 0.25})`.
- `meta.crawl` is present for both towns (5 lines each). Lines hold 2.5 s with a
  0.7 s cross fade. If `crawl` were absent the opening falls back to the first four
  sentences of `meta.story`, as specified.
- The crawl runs **full bleed**: panel, brand, town control, zoom control, the
  ignition marker and the legend are all hidden, and the map takes the full width.
  When the fire starts the panel returns, `invalidateSize` runs and the view is
  reframed for the narrower map.
- Caption is two-stage at the burn: "This is what happened." for 2.6 s, then what
  the viewer is looking at.
- **Skip is always bottom right.** It reads "Skip intro" during the crawl (it jumps
  to the fire) and "Free play" afterwards. One label per meaning rather than one
  label with two behaviours.
- Fly target is the region centre at the zoom that frames the whole grid. Flying to
  the town centre instead would push part of the burn area off screen, and the
  viewer has to see the whole fire to read the story.

## Tier 3: panel and map controls

- Panel is now three blocks: **01 BUDGET**, **02 HOMES SAVED** (big number plus the
  waffle), and a footer line. "More" is gone entirely.
- The time scrubber moved out of the panel to a thin strip along the bottom edge of
  the map: play button, track, elapsed time. It is dimmed but live outside free play.
- The curve and the simplifications list moved behind one small **i** in the panel
  footer, which opens a plain modal. Escape or a click outside closes it.
- Region switching is the mono select at top left, under the brand. Selecting a town
  reloads against that town's `data_dir`, which replays its own crawl.
- Map: `minZoom 4`, `zoomSnap 0.25`, `wheelPxPerZoomLevel 45` and
  `wheelDebounceTime 12` for a fast, smooth wheel. Zoom control moved to the top
  right so it does not collide with the brand.
- **US** button under the zoom control flies to the continental bounds. Below zoom 9
  the fire, glow, ghost and ignition marker fade out and a pin appears for every town
  in `towns/index.json`, labelled with name and event; clicking one loads it.
  Pin centres come from each town's own `meta.bounds`, fetched once in the
  background, since the index carries no coordinates.

## Tier 4: free play

### Parity: the JS sim matches Python exactly

`web/sim.js` implements CONTRACT.md "The algorithm, exactly": directed 8-neighbour
Dijkstra with a binary heap, `min(base_i, base_j)` edge rates, per-edge slope and
one of eight wind constants, weights computed on the fly, arrival rounded to
5-minute buckets. It runs in a Web Worker, so the UI never blocks.

Measured against `web/data/parity.json` on the Paradise grid (152,304 cells):

| case | within 1 bucket | exact | worst delta |
|---|---|---|---|
| baseline | **100.000%** | **100.000%** | 0 buckets |
| with test break | **100.000%** | **100.000%** | 0 buckets |

Target was 99% within one bucket. The result is cell-for-cell identical in both
cases, so the fallback to `POST /api/simulate` was never needed. A full run takes
**73 to 101 ms** (budget was 500 ms), and free play issues two runs per change: one
without the drawn breaks for a fair baseline, one with them.

### Free play behaviour

- Click the map to place the ignition; the fire re-runs from there under the
  current wind.
- Wind is a draggable compass dial plus a speed slider, shown only in free play.
  Changing either re-runs the model.
- "Draw break" turns the map into a drafting surface: drag a line, and every cell
  whose centre lies within one cell of it is cleared, which is the two-cell width
  the solver uses. Undo drops the last line, Clear drops all of them. Cost is
  cells times `cell_acres` times `cost_per_acre` for that cell's fuel class, with
  class 7 (urban) never clearable, per the contract's mapping.
- Drawn breaks render exactly like the solver's, as cleared ground in the fire
  canvas. **Addition:** once the fire burns over a break, the cells keep a pale
  sand tint instead of going charcoal, so the line you cut stays readable in the
  end state. Sampled cells read `130,121,101` against `26,26,26` for burnt ground
  beside them. Without this the break was invisible at the end of a 12 hour run,
  which is where free play leaves the clock.
- The budget slider is hidden in free play. With a custom ignition the solver's
  precomputed breaks no longer apply, and two sources of truth on one map is worse
  than one.
- `story:false` regions skip the opening and land directly in free play, and the
  page no longer requires solver files: `steps.json`, `breaks.geojson`,
  `solutions.json` and `curve.json` are all optional, with the curve hidden when
  absent. Verified by 404ing all four.
- **Region search** appears only when `GET /api/health` answers. On a plain static
  server the box stays hidden and nothing looks broken. Geocoding is Nominatim with
  no key, then `POST /api/region` and a one-second poll of the status endpoint,
  showing the stage and percentage it reports. `serve.py` had not landed when this
  was written, so the happy path is built to the contract but exercised only
  against the degraded path.

## Tier 5: look

Audited against Prime Intellect (dark, technical, hairline rules, mono numerals,
numbered sections) and ollivere (the opening carries the weight, nothing else on
screen competes with it).

- Swept the stylesheet: **no gradients, no shadows, no corner over 3 px**. The only
  `box-shadow` left is the one that removes Leaflet's default.
- Two things I had introduced were removed: a gradient scrim behind the timeline
  strip (now a flat plate with a hairline top) and a glow ring on the region pins.
- Map shapes carry no outlines. Breaks are cleared ground, the ghost perimeter is a
  dashed line because the story needs it, homes are pixels in the grid canvas with
  the 1 px dark edge and green saved ring the brief asks for.
- Text shadows remain on the crawl line, the ignition label and the region labels.
  Those sit over satellite imagery and are for legibility, not decoration.
- Flat dark plates remain behind the caption, the legend and the break tooltip, for
  the same reason. They have no border and a 2 px corner, so they read as caption
  plates rather than cards.
- Saturation: fire is the only saturated thing while a fire is on screen. The green
  saved ring and the amber region pins are the exceptions, and the pins only appear
  in the wide view, where the fire layers are faded out.

### Audio

- Crackle unchanged: brown noise bed plus bandpassed impulses, level tracked to the
  size of the active front.
- Added a **low wind bed under the crawl only**: the same noise through a 190 Hz
  lowpass with a 0.07 Hz breathing LFO, at 0.05 gain, ramped over 1.4 s. It stops
  when the fire starts.
- Nothing autoplays. The audio context is created by the Enter click and by nothing
  else, and the mute toggle sits in the panel footer.

## Tier 6: self-judge loop

Four cycles of screenshot, critique, fix, re-shoot. Thirteen states captured at
1920x1080 into `deck/shots/`: title, crawl, burn, budget, replay, result, free play,
draw break, info modal, US wide view with region pins, Altadena crawl and burn, and
offline mode.

Facts the final cycle returns:

- **Load to interactive: 91 to 99 ms** (first contentful paint 84 ms). The budget was
  3 s. The title card is plain markup, so it paints before any data is fetched.
- **No console errors, no unexpected 404s.** The only 404 is `api/health` on a static
  server, which is the deliberate probe for `serve.py`.
- **Walkthrough completes with no dead end** in every run, ending at `done` with
  "$2M · 4,663 homes saved · 282 min evacuation time."
- **Free play completes** ignite, draw and result: "187 homes saved · $833k ·
  9,393 lost" after drawing across the fire's path.
- Copy sweep over every visible string in every state: **no em dashes, no
  exclamation marks, no sentence over 12 words.**

Fixed during the loop:

1. The panel kept showing the story's "SPENT $2M · +282 MIN EVACUATION" after
   entering free play. Free play now reports its own spend and its own delay to the
   first home, and the numbers are computed before the panel is drawn rather than
   after.
2. The fuel legend sat on top of the timeline strip and its labels collided. It now
   sits above the strip and wraps.
3. Hand-drawn breaks vanished once the fire burnt over them, which is where free
   play leaves the clock. Cleared ground now keeps a pale sand tint through the burn.
4. **The built-up area ended in a hard straight line at the grid boundary**, which
   gave away the rectangle exactly the way the fire used to. Homes now use the same
   edge feather as the fire: nothing drawn in the outer 5 cells, fading in over the
   next 20.
5. Saved-home rings dropped from full alpha to 210 so dense towns read as a texture
   rather than a neon blanket.

Known and left alone: in a dense town like Altadena the standing homes read as a
pale field at region zoom, because there really is a home on nearly every developed
cell. Zooming in resolves them. The colour and alpha are the ones specified.

### Home drift, measured

Homes are pixels inside the fire's grid canvas, so their position is quantised to
the grid. Measured against Leaflet's own projection of the same lat/lon:

| zoom | offset | one grid pixel |
|---|---|---|
| 10 | 0.05 / 0.08 px | 0.26 px |
| 12 | 0.73 / 0.61 px | 1.02 px |
| 14 | 1.84 / 0.97 px | 4.09 px |

The offset never exceeds half a grid pixel, and a five-point continuous-projection
check (no rounding) returns errors inside 0.7 px at all three zooms with **no growth
across zoom**. There is no slide: what remains is the cost of drawing homes as grid
pixels, which is what the grid-canvas approach is for. Earlier readings of 6 px came
from probing a home on the grid edge, where the position is clamped so the saved
ring stays on canvas.

## Merge of PR #1 (Arya) into main, 2026-09-20

Arya's PR branched from before the overnight tiers and rewrote the same four
frontend files. Per instruction the merge takes **his side for the whole
frontend** and his pipeline and data work, keeping ours only where he has no
version. Conservative choices made while resolving:

- **Whole-file, not hunk-level.** `web/app.js`, `web/index.html`, `web/style.css`,
  `web/sim.js`, `pipeline/export.py`, `pipeline/run_all.py` and
  `web/towns/index.json` were taken from his branch outright. A hunk-level merge of
  two independent rewrites would have produced a file neither of us wrote.
- **`web/data/meta.json`: his file, with our `crawl` array put back.** His branch
  has no `crawl` key and the opening needs it. Nothing else of ours was restored.
  `web/towns/altadena/meta.json` was not in his PR, so it keeps our crawl already.
- **Data and towns are his**, because his app is built against his robust-solver
  output (`plan_historical.json`, `robust.json`, regenerated steps/solutions).
  Keeping our older exports would have left his plan toggle pointing at files that
  do not exist. All three towns survive: paradise, altadena, and his santarosa.
  Note his `index.json` drops the `story` flag; his app does not read it.
- **Kept because he has no version:** `web/vendor/fonts/` (Selawik),
  `web/favicon.svg`, `web/FRONTEND_NOTES.md`, `OVERNIGHT_FRONTEND.md`,
  `deck/shots/`, and everything under `web/data/` he did not touch
  (`physics.json`, `parity.json`, `sensitivity.json`).

### The one graft: the cinematic opening

Re-added as **`web/intro.css` + `web/intro.js`**, loaded after leaflet and before
`sim.js`/`app.js`. **His `app.js` is not edited at all.** The handoff works through
his own controls:

1. The overlay draws the FIREBREAK title card (red copy behind, blurred and pushed
   through feTurbulence/feDisplacementMap on an animation frame; the white copy has
   no filter so it never flickers) and one Enter button.
2. Enter is the real user gesture, so the overlay immediately clicks **his**
   `#intro`, which runs his `startApp(true)`: his audio context starts on the
   gesture, and his walkthrough parks at `armed` without starting a fire.
3. `body.fb-crawl` hides his panel, caption and map chrome while the overlay flies
   his map (taken from `window._fb.map`, with an `L.Map.addInitHook` as a second
   route) from zoom 6 to the region over 10 s, one `meta.crawl` line at a time.
4. When the crawl ends, or Skip is pressed, the overlay lifts and clicks his
   `#caption-btn` ("Watch it happen"), which is what starts his fire.

`?intro=0` disables the overlay entirely, so his own tests and flows are untouched.
Deliberately **not** used for handoff: his `#caption-skip`, which jumps to free play
and would skip the story.

## Final pass, item 1: re-ignite loop

Could not reproduce on HEAD: the click, run, Reset, click-elsewhere loop was
verified headlessly three consecutive times at three different points (9,300 /
5,418 / 3,088 homes hit), plus the story-end entry, Reset mid-play, rapid
double-click, and wind-change-then-click paths. All land in a working scenario
with zero console errors. The defect matched the state handling that the
previous pass's enterSandbox replaced, so the fix already shipped; this item is
recorded as verification rather than a second fix.

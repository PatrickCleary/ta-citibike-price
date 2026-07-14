---
name: verify
description: Build, run, and drive the Citi Bike sheds map to observe a change working in the real app.
---

# Verifying changes in the web app

The surface is **pixels on a MapLibre canvas**. Almost nothing here is
provable without a screenshot — `queryRenderedFeatures` counts *placed*
features and ignores opacity, so it can report a full field of markers
that are 100% transparent. Use it for "does the layer exist / is the
filter right", never for "is it visible".

## Run it

```bash
cd app && npm run dev        # Astro; grabs 4321, falls back to 4322 if taken
```

Read the port off the log — don't assume 4321.

## Get a handle on the map

The map instance isn't on `window`. But Vite serves modules by URL and
dedupes by URL, so importing the store from page context resolves to the
*same* module object the app is using:

```js
const map = (await import('/src/lib/mapStore.ts')).useMapStore.getState().map;
const store = (await import('/src/lib/store.ts')).useApp.getState(); // phase/selected
```

Gotcha: `window.__foo = ...` set inside `page.waitForFunction` does **not**
survive into later `page.evaluate` calls. Re-resolve the map inside each
evaluate instead of stashing it.

Playwright needs a local install and its own browser:

```bash
npm i playwright && npx playwright install chromium
```

## Drive it

- `map.jumpTo({center, zoom})` + `await new Promise(r => map.once('idle', r))`
  then a short `waitForTimeout` — the rAF paint loop settles after `idle`.
- Wait ~3.5s after style load for the intro ripple to finish before
  measuring anything, or you'll catch docks mid-wave.
- Dense station field to park over: `[-73.985, 40.745]` (midtown).
- Click a dock: `queryRenderedFeatures({layers:['stations']})[0]`, then
  `map.project(f.geometry.coordinates)` → `page.mouse.click(x, y)`.
- Story steps are driven by the `Show me` / `Replay` buttons in `Narrator`.

## Isolating which layer drew a pixel

A dock draws on two layers (`stations` circles, `stations-icon` pins) that
cross-fade by zoom. To prove which one you're looking at, toggle the other
off and screenshot:

```js
map.setLayoutProperty('stations-icon', 'visibility', 'none');
```

## The heatmap region only draws docks in LOADED tiles

`stations-halo` is a heatmap whose radius is geographic (~500m), so a pixel's
colour depends on docks well outside the viewport. MapLibre can only draw
points from loaded tiles, so if the source subdivides normally, zooming in
starves the region and it flickers as tiles come and go. The `stations` source
therefore pins `maxzoom: 13, buffer: 512` — do not remove these.

To check for starvation, compare docks in loaded tiles against docks actually
within the halo radius:

```js
const rendered = new Set(map.querySourceFeatures('stations').map(f => f.id)).size;
// ...vs a straight-line count from /stations.geojson within 500m of the centre
```
Healthy: ~950+ loaded at z17. Starved: single digits.

## Gotchas

- **Layer add failures are async and easy to swallow.** MapLibre validates
  on `addLayer` and throws; a `try/catch` around it will hide a broken
  expression as "no markers". Always read the console for
  `layers.<id>.<prop>: ...` validation errors.
- `feature-state` is rejected in **layout** properties (e.g. `icon-size`)
  — paint only. It *is* supported in `heatmap-weight` (paint), verified.
- `readPixels` on the map canvas returns nothing: MapLibre runs with
  `preserveDrawingBuffer: false`. Screenshot instead of sampling the canvas.
- Clicking a dock by projecting its coordinates often lands on an overlay (the
  legend is top-left, the intro card top-centre, the Narrator bottom-centre) and
  silently does nothing. Pick a feature in clear space — roughly x 260–640,
  y 300–500 at 800×600 — and assert `phase !== 'intro'` after clicking.
- Harmless noise in the console: `GL Driver Message ... GPU stall due to
  ReadPixels` from headless WebGL.
- Pre-existing `tsc` errors in `src/lib/mapControl.tsx` (`coordinates` on
  `Geometry`) — not yours.

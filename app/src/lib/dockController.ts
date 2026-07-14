// Dock layer controller for the map.
//
// Owns everything about the dock (station) circle layer: its paint, the
// "plop-in" wave animation, and per-dock highlighting. The idea is that all
// dock-level map behaviour lives behind this one controller — today that's the
// wave + selection styling; tooltips/hover cards are the natural next thing to
// add here (see the EXTENSION POINT note near the bottom).
//
// On selection, every dock gets per-feature animation values baked into
// MapLibre feature-state (color, target opacity, base size, stroke, and a
// distance-based `delay`). A single requestAnimationFrame loop then sweeps a
// global `time` past those delays; the paint expressions below turn that into
// a ripple of dots that fade in fast and overshoot ("plop") to their size.
//
// Keeping this out of the React component means the per-frame work is plain
// imperative map calls — no re-renders — and the easing/timing lives in one
// place.

import type {
  ExpressionSpecification,
  CircleLayerSpecification,
  SymbolLayerSpecification,
  HeatmapLayerSpecification,
  FilterSpecification,
  Map,
} from "maplibre-gl";
import { CONTOURS } from "./sheds";

export const DOCKS_SOURCE = "stations";
// The pins get their OWN source, normally tiled — see Map.tsx. DOCKS_SOURCE is
// pinned to maxzoom 13 for the heatmap's sake, which means a zoomed-in view
// overzooms one ~5km tile holding every dock in it. Circles don't care (no
// placement pass); a symbol layer would place hundreds of pins to show ~20.
export const DOCKS_PIN_SOURCE = "stations-pins";
export const DOCKS_LAYER = "stations";
export const DOCKS_ICON_LAYER = "stations-icon";
export const DOCKS_HALO_LAYER = "stations-halo";
export const DOCK_ICON_ID = "dock-pin";

// A station_id no dock can have. Filtering a layer to it is how a layer is made
// to draw nothing — cheaper than opacity 0, which still rasterizes everything.
const NO_DOCK = "__none__";

const SELECTED_COLOR = "#F5532B";
const BASE_COLOR = "#F5532B";
const COLOR_NEAR = CONTOURS[0].color; // ≤11 min — emerald
const COLOR_RING = CONTOURS[1].color; // 11–45 min — indigo

// Reused empty set for selections that show no tiers (a plain highlight).
const EMPTY: Set<string> = new Set();

// WAVE_MS: how long the ripple takes to sweep the whole map (the farthest
// station starts plopping at WAVE_MS). FADE_MS: each dot's own plop duration.
const WAVE_MS = 2400;
const FADE_MS = 500;
const SETTLED = WAVE_MS + FADE_MS + 1; // a `time` past which everything is at rest

// --- circle ⇄ pin cross-fade ----------------------------------------------
// A dock is a dot when the field is dense and a pin once it has room to
// breathe. Both looks live on their own layer over the same source (a circle
// layer can't draw an image), reading the same feature-state; the swap is a
// zoom ramp that fades one out as the other fades in. Below ZOOM_CIRCLE it's
// all dots, above ZOOM_ICON all pins, and in between both are partly drawn.
// Exported because the pin layer's `minzoom` must match this: below it the pins
// are at opacity 0, so the layer may as well not exist (see Map.tsx).
export const ZOOM_CIRCLE = 13;
const ZOOM_ICON = 14.2;

// --- region halo -----------------------------------------------------------
// Each arrived dock claims a soft area around it, and together they read as one
// region. The obvious build — a big translucent circle per dock — doesn't work:
// alpha compositing SUMS, so two 30% circles stack to 51% and the field turns
// into a mottled density map, darkest wherever docks cluster. Opacity tuning
// can't fix that; the overlap has to stop compounding.
//
// So this is a heatmap rather than circles. Density still accumulates, but
// density→colour is a LOOKUP, not a blend — and the ramp below is flat above
// HALO_EDGE, so every covered pixel resolves to the same colour no matter how
// many docks cover it. That's a union, and it costs one layer.
//
// The pleasant side effect: kernels blend before they threshold, so neighbours
// merge into one shape (metaball-style) while isolated docks stay their own
// blob — the region follows the actual street grid and stops at the water.
const HALO_METERS = 500; // ~dock spacing: neighbours merge, outliers don't
const HALO_EDGE = 0.01; // density at which a pixel is "covered"
const HALO_OPACITY = 0.35;
const HALO_BLOOM_MS = 900; // a dock's halo fades in over this, after arrival

// Web-mercator metres per pixel at zoom 0, at NYC's latitude. Pixels per metre
// double every zoom level, so a fixed radius on the ground is an exponential-
// base-2 zoom ramp — anything else and the region breathes as you zoom.
const MPP_Z0 = 156543.03392 * Math.cos((40.74 * Math.PI) / 180);
const haloPx = (z: number) => (HALO_METERS * 2 ** z) / MPP_Z0;

// The halo takes an RGB triple rather than this file's hex, because it has to
// match the TRIP LINE's colour, and tier colours live in tripLines as deck.gl
// triples. Passed in by the caller: importing tripLines here would be circular.
export type Rgb = [number, number, number];
const HALO_DEFAULT: Rgb = [245, 83, 43];

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${a})`;

// The union ramp. Transparent at zero density, then FLAT — identical colour at
// HALO_EDGE and at full density. The flatness is the whole point: it's what
// makes overlaps impossible to see.
const haloColorExpr = (color: Rgb): ExpressionSpecification =>
  [
    "interpolate", ["linear"], ["heatmap-density"],
    0, rgba(color, 0),
    HALO_EDGE, rgba(color, 1),
    1, rgba(color, 1),
  ];

const haloRadiusExpr = (): ExpressionSpecification =>
  ["interpolate", ["exponential", 2], ["zoom"], 10, haloPx(10), 20, haloPx(20)];

const ICON_URL = "/tmap-icon.svg";
// The artwork is padded inside its 186×186 viewBox; this is the pin's tight
// bbox, cropped on rasterize so `icon-anchor: bottom` puts the tip exactly on
// the station rather than ~9% below it.
const ICON_BBOX = { x: 37.2, y: 18.6, w: 111.6, h: 150 };
const ICON_H = 36; // CSS px tall at icon-size 1
const ICON_RATIO = 2; // rasterize at 2× so pins stay crisp on retina

// Rasterize the pin SVG into the map's image sprite. Must resolve before the
// symbol layer is added, or MapLibre warns and draws nothing.
export async function loadDockIcon(map: Map): Promise<void> {
  if (map.hasImage(DOCK_ICON_ID)) return;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`could not load ${ICON_URL}`));
    img.src = ICON_URL;
  });
  const h = ICON_H * ICON_RATIO;
  const w = Math.round((h * ICON_BBOX.w) / ICON_BBOX.h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, ICON_BBOX.x, ICON_BBOX.y, ICON_BBOX.w, ICON_BBOX.h, 0, 0, w, h);
  map.addImage(DOCK_ICON_ID, ctx.getImageData(0, 0, w, h), { pixelRatio: ICON_RATIO });
}

export interface StationPoint {
  id: string;
  lon: number;
  lat: number;
}

export interface Selection {
  selectedId: string;
  near: Set<string>;
  ring: Set<string>;
  showNear: boolean;
  showRing: boolean;
  // Optional per-station appearance delay (wall-ms), e.g. the moment each
  // destination's trip line arrives. When omitted, a straight-line distance
  // ripple is used instead.
  delays?: globalThis.Map<string, number>;
  // Hide (opacity 0) stations that aren't the origin or in a shown tier,
  // instead of dimming them — they stay clickable but invisible.
  hideOthers?: boolean;
  // Docks that make up the region halo, and the colour it renders in.
  // Deliberately NOT derived from near/ring: those style the station DOTS, but
  // during the story the destination dots are TripLines' deck.gl heads, so
  // reusing them here would draw a second dot under every head. The halo is
  // about area only, so it gets its own set.
  halo?: Set<string>;
  haloColor?: string;
}

// --- paint expressions ----------------------------------------------------
// Only the `time` literal changes per frame; everything else reads feature-state.

// ms since this station's wave arrival (negative until its turn comes).
const since = (time: number): ExpressionSpecification =>
  ["-", time, ["coalesce", ["feature-state", "delay"], 0]];

// Opacity snaps in over the first third of the fade — the dot "appears" fast,
// then the size bounce sells the impact.
const appearExpr = (time: number): ExpressionSpecification =>
  ["interpolate", ["linear"], since(time), 0, 0, FADE_MS * 0.3, 1];

// "Plop": scale overshoots its target then settles back, like the dot dropped
// onto the map and squished. Stays at 0 before arrival, clamps to 1 after.
const bounceExpr = (time: number): ExpressionSpecification =>
  [
    "interpolate", ["linear"], since(time),
    0, 0,
    FADE_MS * 0.45, 1.35,  // overshoot past full size
    FADE_MS * 0.72, 0.92,  // settle back, slight undershoot
    FADE_MS, 1.0,
  ];

// A dock's target opacity, faded in by the wave. Shared by both layers — the
// dot and the pin dim together, so `op` still means "how present is this dock".
const litExpr = (time: number): ExpressionSpecification =>
  ["*", ["coalesce", ["feature-state", "op"], 0.85], appearExpr(time)];

// The cross-fade. A zoom interpolate has to be the TOP-LEVEL expression (same
// rule as radiusExpr), so the fade can't be a factor multiplied onto the dot
// opacity — it has to BE the outer interpolate, with the lit value as a stop.
const opacityExpr = (time: number): ExpressionSpecification =>
  [
    "interpolate", ["linear"], ["zoom"],
    ZOOM_CIRCLE, litExpr(time),
    ZOOM_ICON, 0,
  ];

// The pin's half of the cross-fade. Fully STATIC, unlike opacityExpr: no `time`
// and no feature-state, so it's set once at layer creation and never touched.
//
// It can afford to ignore per-dock `op` because `isolate()` already does that
// job with a filter: every step calls isolateOrigin(id) before styling, so the
// only pin drawn during the story is the origin. In the intro nothing is
// isolated, but appearAll gives every dock the same `op` — so there has never
// been a frame where two pins wanted different opacities.
//
// Being state-free is what lets the pins live on their own source (no
// promoteId, no duplicated setFeatureState) — which is what actually makes them
// cheap. See DOCKS_PIN_SOURCE.
const iconOpacityExpr = (): ExpressionSpecification =>
  [
    "interpolate", ["linear"], ["zoom"],
    ZOOM_CIRCLE, 0,
    ZOOM_ICON, 1,
  ];

const radiusExpr = (time: number): ExpressionSpecification => {
  // A zoom interpolate must be the TOP-LEVEL expression, so the per-station
  // size and plop bounce live inside its output stops. Each station's base size
  // is feature-state "r" (zoom-10 px); it scales ~2.4× by zoom 15.
  const r: ExpressionSpecification = ["coalesce", ["feature-state", "r"], 2.5];
  const grow = bounceExpr(time);
  return [
    "interpolate", ["linear"], ["zoom"],
    10, ["*", r, grow],
    15, ["*", r, 2.4, grow],
  ];
};

// Pin scale. Zoom-only, and it has to be: `icon-size` is a LAYOUT property, and
// MapLibre rejects feature-state in layout outright ("feature-state data
// expressions are not supported with layout properties") — the layer won't even
// add. So unlike the dot, the pin can't carry per-dock size or the plop bounce.
//
// The pin ended up static all the way down: icon-opacity dropped its clock and
// its feature-state too (see iconOpacityExpr), so nothing about this layer
// varies per dock or per frame. That's the point — it's what keeps a symbol
// layer off the hot path. If a future step ever shows tier pins at mixed sizes,
// it needs a second symbol layer filtered to that tier with its own static
// icon-size — not a feature-state.
const iconSizeExpr = (): ExpressionSpecification => [
  "interpolate", ["linear"], ["zoom"],
  ZOOM_CIRCLE, 0.55,
  16, 0.9,
];

// Paint for the station circle layer. Color/stroke come from feature-state
// (default to the resting look); opacity/radius start settled at full.
export function stationPaint(): CircleLayerSpecification["paint"] {
  return {
    "circle-color": ["coalesce", ["feature-state", "color"], BASE_COLOR],
    "circle-stroke-color": ["coalesce", ["feature-state", "stroke"], "#ffffff"],
    "circle-stroke-width": 1,
    "circle-radius": radiusExpr(SETTLED),
    "circle-opacity": opacityExpr(SETTLED),
    // The stroke needs the same fade as the fill: it's a separate property that
    // defaults to opaque, so without this the dot's ring survives the cross-fade
    // and hangs around the pin — loudest on the origin, whose stroke is a wide
    // coloured ring rather than a hairline of white.
    "circle-stroke-opacity": opacityExpr(SETTLED),
  };
}

// Layout for the pin layer. Collision is off — 2.4k docks are a field, not
// labels, and MapLibre would otherwise drop most of them; the zoom gate is what
// keeps the pins from piling up, not placement.
export function stationIconLayout(): SymbolLayerSpecification["layout"] {
  return {
    "icon-image": DOCK_ICON_ID,
    "icon-anchor": "bottom",
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "icon-size": iconSizeExpr(),
  };
}

export function stationIconPaint(): SymbolLayerSpecification["paint"] {
  return { "icon-opacity": iconOpacityExpr() };
}

// A dock contributes to the region only once its trip line has arrived, then
// blooms in over HALO_BLOOM_MS. Same `delay` feature-state as the dot wave, so
// the halo and the plop land on the same frame. Non-halo docks weigh 0 and are
// invisible to the density field entirely.
const haloWeightExpr = (time: number): ExpressionSpecification =>
  [
    "*",
    ["coalesce", ["feature-state", "halo"], 0],
    ["interpolate", ["linear"], since(time), 0, 0, HALO_BLOOM_MS, 1],
  ];

// Paint for the region layer. `color` is per-step (emerald for near, indigo for
// far) — the two tiers never render at once, so one layer recoloured is enough
// and there's no cross-tier overlap to muddy.
export function stationHaloPaint(
  color: Rgb = HALO_DEFAULT,
): HeatmapLayerSpecification["paint"] {
  return {
    "heatmap-weight": haloWeightExpr(SETTLED),
    "heatmap-intensity": 1,
    "heatmap-radius": haloRadiusExpr(),
    "heatmap-color": haloColorExpr(color),
    "heatmap-opacity": HALO_OPACITY,
  };
}

export class DockController {
  private map: Map;
  private stations: StationPoint[] = [];
  private byId = new globalThis.Map<string, StationPoint>();
  private time = SETTLED;
  private endTime = SETTLED; // when the current run is fully settled
  private raf: number | null = null;

  constructor(map: Map) {
    this.map = map;
  }

  setStations(list: StationPoint[]) {
    this.stations = list;
    this.byId = new globalThis.Map(list.map((s) => [s.id, s]));
  }

  // Highlight a single dock: paint it red at full opacity and fade the rest of
  // the field down to 0.15 (no tiers shown). This is the plain "I clicked a
  // dock" styling; use `select` directly when you also need near/ring tiers.
  //
  // `wave` (default true) plays the ripple as the field re-settles; pass false
  // to snap straight to the highlighted look.
  selectDock(dockId: string, { wave = true }: { wave?: boolean } = {}) {
    this.select({
      selectedId: dockId,
      near: EMPTY,
      ring: EMPTY,
      showNear: false,
      showRing: false,
    });
    // if (wave) this.start();
    // else this.refresh();
  }

  // Bake each station's target look + appearance delay into feature-state.
  // Call on a new selection or when the visible tiers change.
  select({ selectedId, near, ring, showNear, showRing, delays, hideOthers, halo, haloColor }: Selection) {
    const origin = this.byId.get(selectedId);
    if (!origin || !this.map.getLayer(DOCKS_LAYER)) return;

    if (haloColor && this.map.getLayer(DOCKS_HALO_LAYER)) {
      this.map.setPaintProperty(
        DOCKS_HALO_LAYER,
        "heatmap-color",
        haloColorExpr(haloColor),
      );
    }

    // Straight-line distance ripple, used when no explicit delays are given.
    const cosLat = Math.cos((origin.lat * Math.PI) / 180);
    const dist = (s: StationPoint) =>
      Math.hypot((s.lon - origin.lon) * cosLat, s.lat - origin.lat);
    let max = 0;
    if (!delays) for (const s of this.stations) max = Math.max(max, dist(s));
    max = max || 1;

    let maxDelay = 0;
    for (const s of this.stations) {
      const isSel = s.id === selectedId;
      const inNear = showNear && near.has(s.id);
      const inRing = showRing && ring.has(s.id);

      let op = hideOthers ? 0 : 0.15;
      let color = BASE_COLOR, stroke = "#ffffff", r = 2.5;
      if (isSel) {
        op = 1; color = SELECTED_COLOR; stroke = SELECTED_COLOR; r = 6;
      } else if (inNear) {
        op = 0.95; color = COLOR_NEAR; r = 3;
      } else if (inRing) {
        op = 0.95; color = COLOR_RING; r = 3;
      }

      // Origin appears immediately; others use their arrival delay (or the
      // distance ripple). Hidden dots don't extend the run length — but a halo
      // dock does even at op 0, since during the story the dots are hidden
      // (hideOthers) and the region is the only thing the wave is driving.
      const inHalo = halo?.has(s.id) ? 1 : 0;
      const delay = isSel ? 0 : delays ? (delays.get(s.id) ?? 0) : (dist(s) / max) * WAVE_MS;
      if (op > 0 || inHalo) maxDelay = Math.max(maxDelay, delay);

      this.map.setFeatureState(
        { source: DOCKS_SOURCE, id: s.id },
        { delay, op, color, stroke, r, halo: inHalo },
      );
    }
    // Only the halo docks reach the heatmap; `bare` frames pass none, so the
    // pre-draw step draws no region at all rather than 2.4k invisible kernels.
    this.filterHalo(halo);

    this.endTime = maxDelay + Math.max(FADE_MS, HALO_BLOOM_MS);
  }

  // Intro: ripple the WHOLE station field in at full opacity (no selection),
  // plopping outward from `center`. Used on first load before any station is
  // picked. Call start() after to play it.
  appearAll(center: [number, number]) {
    if (!this.map.getLayer(DOCKS_LAYER)) return;
    // The intro has no region — every dock below is halo: 0. Without this the
    // heatmap still rasterizes all 2.4k kernels, which is what made zooming in
    // from the intro crawl.
    this.filterHalo();
    const cosLat = Math.cos((center[1] * Math.PI) / 180);
    const dist = (s: StationPoint) =>
      Math.hypot((s.lon - center[0]) * cosLat, s.lat - center[1]);
    let max = 0;
    for (const s of this.stations) max = Math.max(max, dist(s));
    max = max || 1;

    let maxDelay = 0;
    for (const s of this.stations) {
      const delay = (dist(s) / max) * WAVE_MS;
      maxDelay = Math.max(maxDelay, delay);
      this.map.setFeatureState(
        { source: DOCKS_SOURCE, id: s.id },
        { delay, op: 0.85, color: BASE_COLOR, stroke: "#ffffff", r: 2.5, halo: 0 },
      );
    }
    this.endTime = maxDelay + FADE_MS;
  }

  // Run the ripple from time 0, then settle.
  start() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    const end = this.endTime;
    const tick = () => {
      const t = performance.now() - t0;
      this.time = t;
      this.applyAnim(t);
      if (t < end) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = null;
        this.time = end + 1;
        this.applyAnim(this.time); // settle exactly at full
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  // Re-apply paint without restarting the ripple (e.g. after toggling tiers).
  // If no run is in flight, settle fully so newly-shown dots aren't stuck hidden.
  refresh() {
    if (this.raf == null) this.time = this.endTime + 1;
    this.applyAnim(this.time);
  }

  // Clear all selection styling — every station back to the resting dot field.
  reset() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (!this.map.getLayer(DOCKS_LAYER)) return;
    this.map.removeFeatureState({ source: DOCKS_SOURCE });
    // Dropping the state leaves every dock at halo 0, so the region is gone —
    // but "weighs nothing" and "isn't drawn" are different things here.
    this.filterHalo();
    this.time = SETTLED;
    this.applyAnim(SETTLED);
  }

  dispose() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // Restrict the heatmap to the docks actually in the region; pass an empty set
  // (or nothing) to draw none at all.
  //
  // This is a pure performance guard, and it's the difference between a zoomed-in
  // view running and crawling. `heatmap-weight` 0 does NOT skip a point: the
  // kernel quad still rasterizes, it just contributes nothing. The quad is sized
  // in PIXELS off a 500m ground radius, so it doubles every zoom level —
  // ~5px across at the intro's zoom 10.3, but ~552px at the origin's zoom 16.
  // Times 2.4k docks, that's ~300k pixels of invisible fill per dock per frame.
  //
  // A filter is the only lever here: feature-state (which is what `halo` lives
  // in) is illegal inside filters, so the id list has to be inlined.
  private filterHalo(ids?: Set<string>) {
    if (!this.map.getLayer(DOCKS_HALO_LAYER)) return;
    this.map.setFilter(
      DOCKS_HALO_LAYER,
      ids?.size
        ? ["in", ["get", "station_id"], ["literal", [...ids]]]
        : ["==", ["get", "station_id"], NO_DOCK],
    );
  }

  // Show only `id`'s dock, or pass null to restore the full clickable field.
  // Lives here rather than in the caller so the dot and the pin can't drift out
  // of sync — a dock is one thing wearing two looks, and both must filter alike.
  isolate(id: string | null) {
    const filter: FilterSpecification | null = id
      ? ["==", ["get", "station_id"], id]
      : null;
    for (const layer of [DOCKS_LAYER, DOCKS_ICON_LAYER]) {
      if (!this.map.getLayer(layer)) continue;
      const cur = this.map.getFilter(layer) as unknown[] | undefined;
      const curId = Array.isArray(cur) ? (cur[2] as string) : null;
      if (id !== curId) this.map.setFilter(layer, filter);
    }
  }

  // --- EXTENSION POINT ----------------------------------------------------
  // Future dock-level UI (hover tooltips / selected-dock cards) belongs here:
  // this controller already owns the layer id, the id→point lookup (`byId`),
  // and the selection state, so tooltip show/hide/position methods would have
  // everything they need without the React component reaching into the map.

  private applyAnim(time: number) {
    if (this.map.getLayer(DOCKS_LAYER)) {
      const op = opacityExpr(time);
      this.map.setPaintProperty(DOCKS_LAYER, "circle-opacity", op);
      this.map.setPaintProperty(DOCKS_LAYER, "circle-stroke-opacity", op);
      this.map.setPaintProperty(DOCKS_LAYER, "circle-radius", radiusExpr(time));
    }
    // The pin layer is absent on purpose: icon-opacity is clockless (see
    // iconOpacityExpr) and icon-size is layout, so there is nothing here to
    // drive per frame. Leave it that way — a symbol layer is the most expensive
    // thing on this map to invalidate.
    if (this.map.getLayer(DOCKS_HALO_LAYER)) {
      this.map.setPaintProperty(DOCKS_HALO_LAYER, "heatmap-weight", haloWeightExpr(time));
    }
  }
}

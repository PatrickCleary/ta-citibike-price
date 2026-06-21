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

import type { ExpressionSpecification, CircleLayerSpecification, Map } from "maplibre-gl";
import { CONTOURS } from "./sheds";

export const STATIONS_SOURCE = "stations";
export const STATIONS_LAYER = "stations";

const SELECTED_COLOR = "#ff2d55";
const BASE_COLOR = "#1f2937";
const COLOR_NEAR = CONTOURS[0].color; // ≤11 min — emerald
const COLOR_RING = CONTOURS[1].color; // 11–45 min — indigo

// Reused empty set for selections that show no tiers (a plain highlight).
const EMPTY: Set<string> = new Set();

// WAVE_MS: how long the ripple takes to sweep the whole map (the farthest
// station starts plopping at WAVE_MS). FADE_MS: each dot's own plop duration.
const WAVE_MS = 2400;
const FADE_MS = 500;
const SETTLED = WAVE_MS + FADE_MS + 1; // a `time` past which everything is at rest

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

const opacityExpr = (time: number): ExpressionSpecification =>
  ["*", ["coalesce", ["feature-state", "op"], 0.85], appearExpr(time)];

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

// Paint for the station circle layer. Color/stroke come from feature-state
// (default to the resting look); opacity/radius start settled at full.
export function stationPaint(): CircleLayerSpecification["paint"] {
  return {
    "circle-color": ["coalesce", ["feature-state", "color"], BASE_COLOR],
    "circle-stroke-color": ["coalesce", ["feature-state", "stroke"], "#ffffff"],
    "circle-stroke-width": 1,
    "circle-radius": radiusExpr(SETTLED),
    "circle-opacity": opacityExpr(SETTLED),
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
  select({ selectedId, near, ring, showNear, showRing, delays, hideOthers }: Selection) {
    const origin = this.byId.get(selectedId);
    if (!origin || !this.map.getLayer(STATIONS_LAYER)) return;

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
      // distance ripple). Hidden dots don't extend the run length.
      const delay = isSel ? 0 : delays ? (delays.get(s.id) ?? 0) : (dist(s) / max) * WAVE_MS;
      if (op > 0) maxDelay = Math.max(maxDelay, delay);

      this.map.setFeatureState(
        { source: STATIONS_SOURCE, id: s.id },
        { delay, op, color, stroke, r },
      );
    }
    this.endTime = maxDelay + FADE_MS;
  }

  // Intro: ripple the WHOLE station field in at full opacity (no selection),
  // plopping outward from `center`. Used on first load before any station is
  // picked. Call start() after to play it.
  appearAll(center: [number, number]) {
    if (!this.map.getLayer(STATIONS_LAYER)) return;
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
        { source: STATIONS_SOURCE, id: s.id },
        { delay, op: 0.85, color: BASE_COLOR, stroke: "#ffffff", r: 2.5 },
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
    if (!this.map.getLayer(STATIONS_LAYER)) return;
    this.map.removeFeatureState({ source: STATIONS_SOURCE });
    this.time = SETTLED;
    this.applyAnim(SETTLED);
  }

  dispose() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // --- EXTENSION POINT ----------------------------------------------------
  // Future dock-level UI (hover tooltips / selected-dock cards) belongs here:
  // this controller already owns the layer id, the id→point lookup (`byId`),
  // and the selection state, so tooltip show/hide/position methods would have
  // everything they need without the React component reaching into the map.

  private applyAnim(time: number) {
    if (!this.map.getLayer(STATIONS_LAYER)) return;
    this.map.setPaintProperty(STATIONS_LAYER, "circle-opacity", opacityExpr(time));
    this.map.setPaintProperty(STATIONS_LAYER, "circle-radius", radiusExpr(time));
  }
}

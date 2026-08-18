// Animated routed-trip lines, drawn with deck.gl over the MapLibre map.
//
// On selection we decode the origin station's per-destination polylines and
// split them into two tiers (≤11 min and the <45 min ). Each vertex
// carries a timestamp = the ride time to reach it at a constant 11.2 mph. The
// two tiers are driven INDEPENDENTLY via setTiers(): the "near" step draws the
// ≤11 set out, the "far" step draws the full ≤45 set out in all-blue.
//
// Each line carries a head (ScatterplotLayer): a bead rides the drawing front,
// then "plops" (scale overshoot) into the destination dock. Lines are drawn as
// fixed-length comets (TRAIL_SECONDS) that fade out behind the head, so a line
// fades away as it arrives. Rendered beneath the MapLibre station layer.

import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "deck.gl";
import { ScatterplotLayer } from "@deck.gl/layers";
import polyline from "@mapbox/polyline";
import type { Map } from "maplibre-gl";
import type { Routes } from "./trips";
import { PLAYBACK_SPEEDUP, type StepKey } from "./store";
import { DOCKS_LAYER } from "./dockController";

export const COLOR_NEAR: [number, number, number] = [245, 83, 43]; // ≤11 min — brand orange
export const COLOR_ALL: [number, number, number] = [99, 102, 241]; // 11–45 min — indigo

// The colour a step draws in: "near" keeps the ≤11 colour, "far" recolours the
// whole ≤45 superset all-blue (see tiersForPhase). The region halo reads this so
// it can't drift from the lines it's summarising.
export const tierColor = (phase: StepKey): [number, number, number] =>
  phase === "near" ? COLOR_NEAR : COLOR_ALL;

// Ride speed used to convert route distance into ride time.
const SPEED_MPS = (11.2 * 1609.344) / 3600; // 11.2 mph ≈ 5.01 m/s
// Maps wall-ms to ride-seconds for the dock plop curve (progress drives the rest).
const PLAYBACK = 600;
// Departure stagger: trips leave in order of straight-line distance from the
// origin (nearest first), spread across this fraction of the tier's slowest
// route duration. Produces a radial ripple; arrivals are not synced.
const SPREAD_FRAC = 0.5;

const TRIP_NEAR = "trip-near";
const TRIP_ALL = "trip-all";
const HEAD_LAYER = "trip-heads";

const TRAVEL_R = 3; // px — bead riding the head of a drawing line
const DOCK_R = 3; // px — settled dot once docked
const PLOP_MS = 450; // wall-clock duration of the dock plop
const WHITE: [number, number, number] = [255, 255, 255];

// Auto-fit breathing room, in px. The narrow mobile viewport can't spare much,
// so it gets a tighter frame than desktop.
const MOBILE_BREAKPOINT = 768;
const FIT_PADDING_MOBILE = 20;
const FIT_PADDING_DESKTOP = 50;
const fitPadding = () =>
  window.innerWidth < MOBILE_BREAKPOINT ? FIT_PADDING_MOBILE : FIT_PADDING_DESKTOP;

// Comet tail length, in ride-seconds. Speed is constant (SPEED_MPS), so this is
// a fixed on-the-ground length: each line is a moving segment of this span that
// fades out behind the head, so a line fully fades once its head docks.
const TRAIL_SECONDS = 180;

interface Trip {
  id: string; // destination station id
  path: [number, number][];
  timestamps: number[];
  color: [number, number, number];
}

interface Head {
  position: [number, number];
  radius: number;
  fill: [number, number, number, number]; // rgba
  line: [number, number, number, number]; // rgba
}

// Per-tier render state set by the phase sequence.
export interface TierState {
  visible: boolean;
  progress: number; // 0..1 draw-out
  opacity: number; // 0..1
  color?: [number, number, number]; // override the trips' baked color (else per-trip)
}

const HIDDEN: TierState = { visible: false, progress: 0, opacity: 1 };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The trip-line frame is a pure function of (step, local progress t ∈ [0,1]):
// step "near" draws the ≤11 set out; step "far" draws the full ≤45 set out in
// all-blue. Returns the two tier states to feed setTiers — all camera/dock
// concerns live elsewhere.
export function tiersForPhase(
  phase: StepKey,
  t: number,
): { near: TierState; all: TierState } {
  if (phase === "near") {
    return {
      near: { visible: true, progress: clamp01(t), opacity: 1 },
      all: HIDDEN,
    };
  }
  // "far": the ≤45 set is a superset of the ≤11 set, so the all tier already
  // covers every near destination — draw it alone, recoloured all-blue. (Don't
  // also draw the near tier: it's scaled by nearEnd, not allEnd, so it'd crawl
  // out at ~nearEnd/allEnd speed as a redundant slow second wave.)
  return {
    near: HIDDEN,
    all: {
      visible: true,
      progress: clamp01(t),
      opacity: 1,
      color: COLOR_ALL,
    },
  };
}

// Interpolated [lng, lat] along a trip at ride-time `t`.
function positionAt(trip: Trip, t: number): [number, number] {
  const ts = trip.timestamps;
  const last = ts.length - 1;
  if (t <= 0) return trip.path[0];
  if (t >= ts[last]) return trip.path[last];
  let lo = 0,
    hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid + 1] <= t) lo = mid + 1;
    else hi = mid;
  }
  const seg = ts[lo + 1] - ts[lo] || 1;
  const f = (t - ts[lo]) / seg;
  const a = trip.path[lo],
    b = trip.path[lo + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
}

// Dock plop: scale overshoots then settles. p in [0, 1].
function overshoot(p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return 1;
  if (p < 0.4) return 1 + 0.4 * (p / 0.4); // 1 → 1.4
  if (p < 0.7) return 1.4 - 0.5 * ((p - 0.4) / 0.3); // 1.4 → 0.9
  return 0.9 + 0.1 * ((p - 0.7) / 0.3); // 0.9 → 1
}

// Rough equirectangular metres between two [lng, lat] points.
function meters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  const dx = (((b[0] - a[0]) * Math.PI) / 180) * cosLat;
  const dy = ((b[1] - a[1]) * Math.PI) / 180;
  return R * Math.hypot(dx, dy);
}

function decode(
  id: string,
  poly: string,
  color: [number, number, number],
  start: number,
): Trip | null {
  // polyline.decode → [[lat, lng], ...]; deck wants [lng, lat].
  const path = polyline
    .decode(poly, 5)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (path.length < 2) return null;
  // timestamps are ride-seconds at SPEED_MPS (cumulative), offset by start.
  const timestamps = [start];
  for (let i = 1; i < path.length; i++) {
    timestamps.push(
      timestamps[i - 1] + meters(path[i - 1], path[i]) / SPEED_MPS,
    );
  }
  return { id, path, timestamps, color };
}

function endTimeOf(trips: Trip[]): number {
  const maxTime = trips.reduce(
    (m, t) => Math.max(m, t.timestamps[t.timestamps.length - 1]),
    1,
  );
  // Reserve a tail so the last arrival's dock plop completes at progress 1.
  return maxTime + (PLOP_MS / 1000) * PLAYBACK;
}

// Push each trip's departure later in proportion to its straight-line distance
// from the origin, so trips ripple outward nearest-first. The offset is added to
// every timestamp (start = timestamps[0]); the farthest leaves at
// SPREAD_FRAC * the tier's slowest route duration. Mutates `trips` in place.
function staggerByDistance(trips: Trip[], origin: [number, number]) {
  const dist = (t: Trip) => meters(origin, t.path[t.path.length - 1]);
  const maxDist = trips.reduce((m, t) => Math.max(m, dist(t)), 0) || 1;
  const maxDur = trips.reduce(
    (m, t) => Math.max(m, t.timestamps[t.timestamps.length - 1]),
    0,
  );
  const spread = maxDur * SPREAD_FRAC;
  for (const t of trips) {
    const start = (dist(t) / maxDist) * spread;
    if (start)
      for (let i = 0; i < t.timestamps.length; i++) t.timestamps[i] += start;
  }
}

export class TripLines {
  private overlay: MapboxOverlay;
  private nearTrips: Trip[] = [];
  private allTrips: Trip[] = [];
  private nearEnd = 1;
  private allEnd = 1;
  private origin: [number, number] | null = null; // [lng, lat]
  private map: Map;
  // Accumulated geographic extent of the drawn trip points. Only ever unions in
  // new points (never shrinks within a draw), so the camera eases strictly
  // outward and can't wobble back in. Reset on show()/clear().
  private pointBounds: [[number, number], [number, number]] | null = null;
  // When false, setTiers paints frames without touching the camera. Only a
  // running draw-out tween (via beginAutoFit) owns the camera — this keeps
  // static paints and the selection flyTo from being stomped by fitBounds.
  private autoFit = false;

  constructor(map: Map) {
    this.map = map;
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay);
  }

  // Only insert under the station layer once it exists (added on map `load`).
  private beforeId(): string | undefined {
    return this.map.getLayer(DOCKS_LAYER) ? DOCKS_LAYER : undefined;
  }

  getOrigin(): [number, number] | null {
    return this.origin;
  }

  // Total ride-seconds for a phase's draw-out (departure stagger + travel +
  // dock-plop tail). Drives constant-bike-speed playback in StoryController.
  rideSecondsFor(phase: StepKey): number {
    return phase === "near" ? this.nearEnd : this.allEnd;
  }

  private tripsFor(phase: StepKey): Trip[] {
    return phase === "near" ? this.nearTrips : this.allTrips;
  }

  // The destination docks this step rides out to.
  destinations(phase: StepKey): Set<string> {
    return new Set(this.tripsFor(phase).map((t) => t.id));
  }

  // Per-destination arrival as wall-ms from the start of this step's draw-out —
  // the instant that dock's bead docks. Trip timestamps are ride-seconds and the
  // draw-out plays at PLAYBACK_SPEEDUP, so this is the same conversion play()
  // uses for its duration. Feeds DockController.Selection.delays, which is in
  // wall-ms, so the dot plop and region halo land on the arriving line's frame.
  arrivalDelays(phase: StepKey): globalThis.Map<string, number> {
    const out = new globalThis.Map<string, number>();
    for (const t of this.tripsFor(phase)) {
      const arrival = t.timestamps[t.timestamps.length - 1];
      out.set(t.id, (arrival * 1000) / PLAYBACK_SPEEDUP);
    }
    return out;
  }

  // Decode a station's routes into the two tiers. The all tier is the <45 min
  // band; the ≤11 set is its own tier (and stays its colour throughout).
  show(routes: Routes) {
    const near = new Set(Object.keys(routes["11"]));
    this.nearTrips = Object.keys(routes["11"])
      .map((dest) => decode(dest, routes["11"][dest], COLOR_NEAR, 0))
      .filter((t): t is Trip => t !== null);
    this.allTrips = Object.keys(routes["45"])
      .map((dest) => decode(dest, routes["45"][dest], COLOR_ALL, 0))
      .filter((t): t is Trip => t !== null);

    this.origin = routes.origin;
    // staggerByDistance(this.nearTrips, this.origin);
    // staggerByDistance(this.allTrips, this.origin);
    this.nearEnd = endTimeOf(this.nearTrips);
    this.allEnd = endTimeOf(this.allTrips);
    this.pointBounds = null;

    this.setTiers(HIDDEN, HIDDEN);
  }

  // Drive the two tiers. Called every frame by the phase sequence.
  setTiers(near: TierState, all: TierState) {
    const heads: Head[] = [];

    // Union each drawn point into the accumulated extent (monotonic — never
    // shrinks within a draw), so the camera below only ever eases outward.
    let grew = false;
    const includePoint = (p: [number, number]) => {
      if (!this.pointBounds) {
        this.pointBounds = [
          [p[0], p[1]],
          [p[0], p[1]],
        ];
        grew = true;
        return;
      }
      const b = this.pointBounds;
      if (p[0] < b[0][0]) {
        b[0][0] = p[0];
        grew = true;
      }
      if (p[1] < b[0][1]) {
        b[0][1] = p[1];
        grew = true;
      }
      if (p[0] > b[1][0]) {
        b[1][0] = p[0];
        grew = true;
      }
      if (p[1] > b[1][1]) {
        b[1][1] = p[1];
        grew = true;
      }
    };

    const build = (trips: Trip[], end: number, tier: TierState) => {
      if (!tier.visible) return;
      const time = tier.progress * end;
      const alpha = Math.round(tier.opacity * 255);
      for (const t of trips) {
        if (time < t.timestamps[0]) continue; // not departed (jitter window)
        const col = tier.color ?? t.color; // tier override, else baked per-trip
        const arrival = t.timestamps[t.timestamps.length - 1];
        let pos: [number, number];
        let radius: number;
        let fill: [number, number, number, number];
        let line: [number, number, number, number];
        if (time < arrival) {
          pos = positionAt(t, time); 
          includePoint(pos);

          radius = TRAVEL_R;
          fill = [...WHITE, alpha];
          line = [...col, alpha];
        } else {
          const plopMs = ((time - arrival) / PLAYBACK) * 1000;
          radius = DOCK_R * overshoot(Math.min(plopMs / PLOP_MS, 1));
          pos = t.path[t.path.length - 1];
          includePoint(pos);

          fill = [...col, alpha];
          line = [...WHITE, alpha];
        }
        heads.push({ position: pos, radius, fill, line });
      }
    };

    build(this.nearTrips, this.nearEnd, near);
    build(this.allTrips, this.allEnd, all);

    // Frame the accumulated point extent — but only while a draw-out tween owns
    // the camera (beginAutoFit)
    if (this.autoFit && this.pointBounds && grew) {
      this.map.fitBounds(this.pointBounds, {
        padding: fitPadding(),
        duration: 100,
      });
    }

    const beforeId = this.beforeId();
    const tripLayer = (
      id: string,
      trips: Trip[],
      end: number,
      tier: TierState,
    ) =>
      new TripsLayer<Trip>({
        id,
        data: tier.visible ? trips : [],
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => tier.color ?? d.color,
        updateTriggers: { getColor: tier.color?.join() ?? "self" },
        getWidth: 4,
        widthUnits: "pixels",
        widthMinPixels: 2.5,
        capRounded: true,
        jointRounded: true,
        opacity: tier.opacity,
        currentTime: tier.progress * end,
        trailLength: TRAIL_SECONDS, // fixed-length comet that fades behind the head
        fadeTrail: true,
        // valid in interleaved mode; not in the layer prop typings
        // @ts-expect-error
        beforeId,
      });

    this.overlay.setProps({
      layers: [
        // near under all so the 45-min set overlays the faded 11-min set
        tripLayer(TRIP_NEAR, this.nearTrips, this.nearEnd, near),
        tripLayer(TRIP_ALL, this.allTrips, this.allEnd, all),
        new ScatterplotLayer<Head>({
          id: HEAD_LAYER,
          data: heads,
          getPosition: (d) => d.position,
          getRadius: (d) => d.radius,
          getFillColor: (d) => d.fill,
          getLineColor: (d) => d.line,
          radiusUnits: "pixels",
          stroked: true,
          lineWidthUnits: "pixels",
          getLineWidth: 1.2,
          // valid in interleaved mode; not in the layer prop typings
          // @ts-expect-error
          beforeId,
        }),
      ],
    });
  }

  // Take camera ownership for a draw-out tween: seed the extent from the CURRENT
  // viewport (so framing grows outward from wherever the camera is now — e.g.
  // after the selection flyTo) and enable the per-frame outward fit.
  //
  // Remove the padding from the viewport so that the first call to fitBounds doesn't jump the camera unexpectedly.
  beginAutoFit() {
    const el = this.map.getContainer();
    const w = el.clientWidth;
    const h = el.clientHeight;
    const p = fitPadding();
    // Guard a viewport too small to inset (narrow phones, split panes).
    const px = Math.min(p, Math.max(0, w / 2 - 1));
    const py = Math.min(p, Math.max(0, h / 2 - 1));
    // unproject takes CSS pixels — clientWidth/Height, not the DPR-scaled canvas.
    const sw = this.map.unproject([px, h - py]);
    const ne = this.map.unproject([w - px, py]);
    this.pointBounds = [
      [sw.lng, sw.lat],
      [ne.lng, ne.lat],
    ];
    this.autoFit = true;
  }

  // Release camera ownership; subsequent static paints leave the camera alone.
  endAutoFit() {
    this.autoFit = false;
  }

  clear() {
    this.nearTrips = [];
    this.allTrips = [];
    this.pointBounds = null;
    this.autoFit = false;
    this.overlay.setProps({ layers: [] });
  }

  dispose() {
    this.overlay.setProps({ layers: [] });
  }
}

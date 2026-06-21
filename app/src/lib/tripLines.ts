// Animated routed-trip lines, drawn with deck.gl over the MapLibre map.
//
// On selection we decode the origin station's per-destination polylines and
// split them into two tiers (≤11 min and the <45 min ). Each vertex
// carries a timestamp = the ride time to reach it at a constant 11.2 mph. The
// two tiers are driven INDEPENDENTLY via setTiers(): the phase sequence scrubs
// the ≤11 set first, then fades it back and draws the full ≤45 set on top.
//
// Each line carries a head (ScatterplotLayer): a bead rides the drawing front,
// then "plops" (scale overshoot) into the destination dock. fadeTrail is off,
// so lines persist once drawn. Rendered beneath the MapLibre station layer.

import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "deck.gl";
import { ScatterplotLayer } from "@deck.gl/layers";
import polyline from "@mapbox/polyline";
import type { Map } from "maplibre-gl";
import type { Routes } from "./trips";
import type { StepKey } from "./store";
import { STATIONS_LAYER } from "./dockController";

const COLOR_NEAR: [number, number, number] = [16, 185, 129]; // ≤11 min — emerald
export const COLOR_ALL: [number, number, number] = [99, 102, 241]; // 11–45 min — indigo

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

// The "near" step plays in two beats: the first FLY fraction of t is a lead-in
// (lines still hidden), the rest draws the ≤11 trips out.
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// The trip-line story is a pure function of (step, local progress t ∈ [0,1]):
// step "near" draws the ≤11 set out, "fade" fades it back, "all" redraws it in
// all-blue alongside the full <45 set. Returns the two tier states to feed
// setTiers — all camera/dock concerns live elsewhere.
export function tiersForPhase(
  phase: StepKey,
  t: number,
): { near: TierState; all: TierState } {
  if (phase === "near") {
    const np = clamp01(t);
    return { near: { visible: true, progress: np, opacity: 1 }, all: HIDDEN };
  }
  if (phase === "fade") {
    return {
      near: { visible: true, progress: 1, opacity: 1 - t },
      all: HIDDEN,
    };
  }
  return {
    near: { visible: true, progress: t, opacity: 1, color: COLOR_ALL },
    all: { visible: true, progress: t, opacity: 1 },
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
    if (start) for (let i = 0; i < t.timestamps.length; i++) t.timestamps[i] += start;
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

  constructor(map: Map) {
    this.map = map;
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay);
  }

  // Only insert under the station layer once it exists (added on map `load`).
  private beforeId(): string | undefined {
    return this.map.getLayer(STATIONS_LAYER) ? STATIONS_LAYER : undefined;
  }

  getOrigin(): [number, number] | null {
    return this.origin;
  }

  // Total ride-seconds for a phase's draw-out (departure stagger + travel +
  // dock-plop tail). Drives constant-bike-speed playback in StoryController.
  rideSecondsFor(phase: StepKey): number {
    return phase === "near" ? this.nearEnd : this.allEnd;
  }

  // Decode a station's routes into the two tiers. The all tier is the <45 min
  // band; the ≤11 set is its own tier (and stays its colour throughout).
  show(routes: Routes) {
    const near = new Set(Object.keys(routes["11"]));
    this.nearTrips = Object.keys(routes["11"])
      .map((dest) => decode(dest, routes["11"][dest], COLOR_NEAR, 0))
      .filter((t): t is Trip => t !== null);
    this.allTrips = Object.keys(routes["45"])
      .map((dest) =>
        decode(dest, routes["45"][dest], near.has(dest) ? COLOR_NEAR : COLOR_ALL, 0),
      )
      .filter((t): t is Trip => t !== null);

    this.origin = routes.origin;
    staggerByDistance(this.nearTrips, this.origin);
    staggerByDistance(this.allTrips, this.origin);
    this.nearEnd = endTimeOf(this.nearTrips);
    this.allEnd = endTimeOf(this.allTrips);

    this.setTiers(HIDDEN, HIDDEN);
  }

  // Drive the two tiers. Called every frame by the phase sequence.
  setTiers(near: TierState, all: TierState) {
    const heads: Head[] = [];
    const currentBounds = this.map.getBounds().toArray();
    const maxBounds: [[number, number], [number, number]] = [
      [...currentBounds[0]] as [number, number],
      [...currentBounds[1]] as [number, number],
    ];
    let boundsExpanded = false;
    // Extent of the trip points alone (separate from the viewport union above):
    // it's static within a phase and only grows when the all-tier draws, so it's
    // the right thing to guard the camera fit on.
    let content: [[number, number], [number, number]] | null = null;

    const includePointInMaxBounds = (p: [number, number]) => {
      if (p[0] < maxBounds[0][0]) {
        maxBounds[0][0] = p[0];
        boundsExpanded = true;
      }
      if (p[1] < maxBounds[0][1]) {
        maxBounds[0][1] = p[1];
        boundsExpanded = true;
      }
      if (p[0] > maxBounds[1][0]) {
        maxBounds[1][0] = p[0];
        boundsExpanded = true;
      }
      if (p[1] > maxBounds[1][1]) {
        maxBounds[1][1] = p[1];
        boundsExpanded = true;
      }
      if (!content) {
        content = [
          [p[0], p[1]],
          [p[0], p[1]],
        ];
      } else {
        if (p[0] < content[0][0]) content[0][0] = p[0];
        if (p[1] < content[0][1]) content[0][1] = p[1];
        if (p[0] > content[1][0]) content[1][0] = p[0];
        if (p[1] > content[1][1]) content[1][1] = p[1];
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
          includePointInMaxBounds(pos);

          radius = TRAVEL_R;
          fill = [...WHITE, alpha];
          line = [...col, alpha];
        } else {
          const plopMs = ((time - arrival) / PLAYBACK) * 1000;
          radius = DOCK_R * overshoot(Math.min(plopMs / PLOP_MS, 1));
          pos = t.path[t.path.length - 1];
          includePointInMaxBounds(pos);

          fill = [...col, alpha];
          line = [...WHITE, alpha];
        }
        heads.push({ position: pos, radius, fill, line });
      }
    };

    build(this.nearTrips, this.nearEnd, near);
    build(this.allTrips, this.allEnd, all);

    // When the trips fall outside the current view, ease the camera to frame
    // them — but only when the content has grown past what we last framed, so the
    // ease isn't retriggered every frame while it's still in flight (or once the
    // user has panned).
    if (boundsExpanded && content) {
      this.map.fitBounds(content, {
        padding: 100,
        duration: 500,
        easing: (t) => t, // linear so the ease doesn't fight the per-frame paints
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
        getWidth: 2,
        widthUnits: "pixels",
        widthMinPixels: 2.5,
        capRounded: true,
        jointRounded: true,
        opacity: tier.opacity,
        currentTime: tier.progress * end,
        trailLength: end, // no fade — keep lines once drawn
        fadeTrail: false,
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

  clear() {
    this.nearTrips = [];
    this.allTrips = [];
    this.overlay.setProps({ layers: [] });
  }

  dispose() {
    this.overlay.setProps({ layers: [] });
  }
}

// Animated routed-trip lines, drawn with deck.gl over the MapLibre map.
//
// On selection we decode the origin station's per-destination polylines and
// split them into two tiers (≤11 min and the 11–45 min ring). Each vertex
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
import { STATIONS_LAYER } from "./stationWave";

const COLOR_NEAR: [number, number, number] = [16, 185, 129]; // ≤11 min — emerald
export const COLOR_RING: [number, number, number] = [99, 102, 241]; // 11–45 min — indigo

// Ride speed used to convert route distance into ride time.
const SPEED_MPS = (11.2 * 1609.344) / 3600; // 11.2 mph ≈ 5.01 m/s
// Maps wall-ms to ride-seconds for the dock plop curve (progress drives the rest).
const PLAYBACK = 600;
// Random per-trip departure stagger so they don't all leave at once.
const JITTER_MS = 500;
const JITTER_RIDE = (JITTER_MS / 1000) * PLAYBACK;

const TRIP_NEAR = "trip-near";
const TRIP_RING = "trip-ring";
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
  jitter: number,
): Trip | null {
  // polyline.decode → [[lat, lng], ...]; deck wants [lng, lat].
  const path = polyline
    .decode(poly, 5)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (path.length < 2) return null;
  // timestamps are ride-seconds at SPEED_MPS (cumulative), offset by jitter.
  const timestamps = [jitter];
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

export class TripLines {
  private overlay: MapboxOverlay;
  private nearTrips: Trip[] = [];
  private ringTrips: Trip[] = [];
  private nearEnd = 1;
  private ringEnd = 1;
  private origin: [number, number] | null = null; // [lng, lat]
  private drawnRadius = 0; // metres from origin to the furthest drawn head
  private nearRadius = 0; // metres to the furthest ≤11-min destination (final)
  private allRadius = 0; // metres to the furthest ≤45-min destination (final)
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
  getDrawnRadius(): number {
    return this.drawnRadius;
  }
  // Final extent of a tier (metres from origin to its furthest destination),
  // independent of draw progress — used to frame a steady camera per phase.
  getNearRadius(): number {
    return this.nearRadius;
  }
  getAllRadius(): number {
    return this.allRadius;
  }

  // Decode a station's routes into the two tiers. The ring is the 11–45 min
  // band; the ≤11 set is its own tier (and stays its colour throughout).
  show(routes: Routes) {
    const near = new Set(Object.keys(routes["11"]));
    this.nearTrips = [];
    this.ringTrips = [];
    for (const [dest, poly] of Object.entries(routes["45"])) {
      const isNear = near.has(dest);
      const t = decode(
        dest,
        poly,
        isNear ? COLOR_NEAR : COLOR_RING,
        Math.random() * JITTER_RIDE,
      );
      if (!t) continue;
      (isNear ? this.nearTrips : this.ringTrips).push(t);
    }
    this.origin = routes.origin;
    this.nearEnd = endTimeOf(this.nearTrips);
    this.ringEnd = endTimeOf(this.ringTrips);

    // Final tier extents: furthest destination (last path vertex) per tier.
    const o = this.origin;
    const reach = (trips: Trip[]) =>
      trips.reduce((m, t) => Math.max(m, meters(o, t.path[t.path.length - 1])), 0);
    this.nearRadius = reach(this.nearTrips);
    this.allRadius = Math.max(this.nearRadius, reach(this.ringTrips));

    this.setTiers(HIDDEN, HIDDEN);
  }

  // Drive the two tiers. Called every scroll frame by the phase sequence.
  setTiers(near: TierState, ring: TierState) {
    const heads: Head[] = [];
    let maxR = 0;

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
          radius = TRAVEL_R;
          fill = [...WHITE, alpha];
          line = [...col, alpha];
        } else {
          const plopMs = ((time - arrival) / PLAYBACK) * 1000;
          radius = DOCK_R * overshoot(Math.min(plopMs / PLOP_MS, 1));
          pos = t.path[t.path.length - 1];
          fill = [...col, alpha];
          line = [...WHITE, alpha];
        }
        heads.push({ position: pos, radius, fill, line });
        if (this.origin) maxR = Math.max(maxR, meters(this.origin, pos));
      }
    };

    build(this.nearTrips, this.nearEnd, near);
    build(this.ringTrips, this.ringEnd, ring);

    this.drawnRadius = maxR;

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
        // near under ring so the 45-min set overlays the faded 11-min set
        tripLayer(TRIP_NEAR, this.nearTrips, this.nearEnd, near),
        tripLayer(TRIP_RING, this.ringTrips, this.ringEnd, ring),
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
    this.ringTrips = [];
    this.drawnRadius = 0;
    this.overlay.setProps({ layers: [] });
  }

  dispose() {
    this.overlay.setProps({ layers: [] });
  }
}

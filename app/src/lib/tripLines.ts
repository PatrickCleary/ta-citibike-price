// Animated routed-trip lines, drawn with deck.gl over the MapLibre map.
//
// On selection we decode the origin station's per-destination polylines and
// feed them to a deck.gl TripsLayer. Each vertex carries a timestamp = the ride
// time to reach it at a constant 11.2 mph. A global `currentTime` is driven by
// scroll progress (see setProgress): scrolling scrubs every line outward from
// the origin, nearer destinations completing first. fadeTrail is off, so lines
// persist once drawn.
//
// A second layer (ScatterplotLayer) renders a dot riding the head of each line;
// when it reaches the destination dock it "plops" (scale overshoot) and settles
// into the destination's dot. Rendered beneath the MapLibre station layer.

import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "deck.gl";
import { ScatterplotLayer } from "@deck.gl/layers";
import polyline from "@mapbox/polyline";
import type { Map } from "maplibre-gl";
import type { Routes } from "./trips";
import { STATIONS_LAYER } from "./stationWave";

const COLOR_NEAR: [number, number, number] = [16, 185, 129]; // ≤11 min — emerald
const COLOR_RING: [number, number, number] = [99, 102, 241]; // 11–45 min — indigo

// Ride speed used to convert route distance into ride time.
const SPEED_MPS = (11.2 * 1609.344) / 3600; // 11.2 mph ≈ 5.01 m/s
// Maps wall-ms to ride-seconds for the dock plop curve (the only remaining
// wall-time-shaped piece now that scroll drives the clock).
const PLAYBACK = 600;
// Random per-trip departure stagger so they don't all leave at once. Expressed
// in wall-ms, converted to ride-seconds for the shared clock.
const JITTER_MS = 500;
const JITTER_RIDE = (JITTER_MS / 1000) * PLAYBACK;
const TRIP_LAYER = "trip-lines";
const HEAD_LAYER = "trip-heads";

const TRAVEL_R = 4; // px — bead riding the head of a drawing line
const DOCK_R = 4.5; // px — settled dot once docked
const PLOP_MS = 450; // wall-clock duration of the dock plop
const WHITE: [number, number, number] = [255, 255, 255];

interface Trip {
  id: string; // destination station id
  path: [number, number][];
  timestamps: number[];
  color: [number, number, number];
  near: boolean; // in the ≤11-min tier
}

interface Head {
  position: [number, number];
  radius: number;
  fill: [number, number, number];
  line: [number, number, number];
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
function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  const dx = (((b[0] - a[0]) * Math.PI) / 180) * cosLat;
  const dy = ((b[1] - a[1]) * Math.PI) / 180;
  return R * Math.hypot(dx, dy);
}

function decode(
  id: string,
  poly: string,
  near: boolean,
  jitter: number,
): Trip | null {
  // polyline.decode → [[lat, lng], ...]; deck wants [lng, lat].
  const path = polyline
    .decode(poly, 5)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (path.length < 2) return null;
  // timestamps are ride-seconds at SPEED_MPS (cumulative), offset by the trip's
  // random departure jitter so it leaves slightly after t=0.
  const timestamps = [jitter];
  for (let i = 1; i < path.length; i++) {
    timestamps.push(
      timestamps[i - 1] + metres(path[i - 1], path[i]) / SPEED_MPS,
    );
  }
  return { id, path, timestamps, color: near ? COLOR_NEAR : COLOR_RING, near };
}

export class TripLines {
  private overlay: MapboxOverlay;
  private trips: Trip[] = [];
  private endTime = 1; // ride-seconds at full scroll (last arrival + plop tail)
  private currentTime = 0;
  private showNear = true;
  private showRing = true;
  private origin: [number, number] | null = null; // [lng, lat]
  private drawnRadius = 0; // metres from origin to the furthest drawn head

  // Origin coordinate of the current selection ([lng, lat]), or null.
  getOrigin(): [number, number] | null {
    return this.origin;
  }
  // How far (metres) the trips currently reach from the origin — for camera fit.
  getDrawnRadius(): number {
    return this.drawnRadius;
  }

  constructor(map: Map) {
    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(this.overlay);
  }

  // Decode a station's routes; nothing is drawn until scroll advances progress.
  show(routes: Routes, showNear: boolean, showRing: boolean) {
    const near = new Set(Object.keys(routes["11"]));
    const trips: Trip[] = [];
    for (const [dest, poly] of Object.entries(routes["45"])) {
      const t = decode(dest, poly, near.has(dest), Math.random() * JITTER_RIDE);
      if (t) trips.push(t);
    }
    this.trips = trips;
    this.origin = routes.origin;
    const maxTime = trips.reduce(
      (m, t) => Math.max(m, t.timestamps[t.timestamps.length - 1]),
      1,
    );
    // Reserve a tail so the last arrival's dock plop completes at progress 1.
    this.endTime = maxTime + (PLOP_MS / 1000) * PLAYBACK;
    this.showNear = showNear;
    this.showRing = showRing;
    this.render(0);
  }

  // Scrub the draw-out to a scroll progress in [0, 1].
  setProgress(p: number) {
    const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
    this.render(clamped * this.endTime);
  }

  // Toggle visible tiers without changing progress.
  setVisibility(showNear: boolean, showRing: boolean) {
    this.showNear = showNear;
    this.showRing = showRing;
    this.render(this.currentTime);
  }

  clear() {
    this.trips = [];
    this.overlay.setProps({ layers: [] });
  }

  dispose() {
    this.overlay.setProps({ layers: [] });
  }

  private render(time: number) {
    this.currentTime = time;
    const data = this.trips.filter((t) =>
      t.near ? this.showNear : this.showRing,
    );

    // Head dot for each visible, departed trip: rides the line while drawing,
    // then plops into place once it reaches the destination dock. Track the
    // furthest head from the origin so the camera can fit the drawn extent.
    const heads: Head[] = [];
    let maxR = 0;
    for (const t of data) {
      if (time < t.timestamps[0]) continue; // not departed yet (jitter window)
      const arrival = t.timestamps[t.timestamps.length - 1];
      let pos: [number, number];
      if (time < arrival) {
        // Traveling: white bead with a colored ring, so it pops off the line.
        pos = positionAt(t, time);
        heads.push({ position: pos, radius: TRAVEL_R, fill: WHITE, line: t.color });
      } else {
        // Docked: colored dot with a white ring; plop scale overshoots.
        const plopMs = ((time - arrival) / PLAYBACK) * 1000;
        const radius = DOCK_R * overshoot(Math.min(plopMs / PLOP_MS, 1));
        pos = t.path[t.path.length - 1];
        heads.push({ position: pos, radius, fill: t.color, line: WHITE });
      }
      if (this.origin) maxR = Math.max(maxR, metres(this.origin, pos));
    }
    this.drawnRadius = maxR;

    this.overlay.setProps({
      layers: [
        new TripsLayer<Trip>({
          id: TRIP_LAYER,
          data,
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: (d) => d.color,
          getWidth: 4,
          widthUnits: "pixels",
          widthMinPixels: 2.5,
          capRounded: true,
          jointRounded: true,
          opacity: 0.7,
          currentTime: time,
          trailLength: this.endTime, // no fade — keep lines once drawn
          fadeTrail: false,
          // valid in interleaved mode; not in the layer prop typings
          // @ts-expect-error
          beforeId: STATIONS_LAYER, // render under the MapLibre station layer
        }),
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
          beforeId: STATIONS_LAYER,
        }),
      ],
    });
  }
}

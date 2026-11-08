// Which landmarks a pick's walkshed reaches. The story's reflect step names the
// farthest few landmarks inside the ≤11-minute shed and the nearest few outside
// it ("You can get to A, B and C, but not D, E or F."); the compare step names
// the farthest iconic (tier 1) ones the ≤45-minute shed reaches.
//
// "Reaches" means any part of the place: the pin, or any point sampled along
// its footprint (data/landmarkAreas.json, from OpenStreetMap via
// scripts/build-landmark-areas.mjs) — a park's pin sits in its middle, but a
// ride to its edge has reached the park. Landmarks no station's walkshed ever
// covers (data/landmarkReachability.json, scripts/build-landmark-reach.mjs) are
// left out of both lists: "but not JFK" would be true from everywhere.
//
// Cheap enough to do per pick at runtime: a few thousand points against one
// shed with a plain ray-cast, no precomputation beyond those two data files.

import type { MultiPolygon, Polygon, Position } from "geojson";
import { LANDMARKS, type Landmark } from "../data/landmarks";
import areas from "../data/landmarkAreas.json";
import everReachable from "../data/landmarkReachability.json";
import type { Walkshed } from "./walksheds";

const AREAS = areas as unknown as Record<string, [number, number][]>;
const EVER = everReachable as Record<string, boolean>;

export interface LandmarkReach {
  /** Reachable landmarks, farthest from the origin first (up to `count`). */
  reachable: Landmark[];
  /** Unreachable landmarks, nearest the origin first (up to `count`). */
  unreachable: Landmark[];
}

// Ray-cast point-in-ring (even-odd). `ring` is a closed or open GeoJSON ring.
function inRing([x, y]: [number, number], ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Inside the outer ring and outside every hole.
function inPolygon(p: [number, number], rings: Position[][]): boolean {
  if (!rings.length || !inRing(p, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (inRing(p, rings[i])) return false;
  return true;
}

function inGeometry(p: [number, number], g: Polygon | MultiPolygon): boolean {
  return g.type === "Polygon"
    ? inPolygon(p, g.coordinates)
    : g.coordinates.some((rings) => inPolygon(p, rings));
}

// Does the shed cover any part of the landmark?
export function reaches(
  l: Landmark,
  shapes: (Polygon | MultiPolygon)[],
): boolean {
  const pin: [number, number] = [l.lon, l.lat];
  if (shapes.some((g) => inGeometry(pin, g))) return true;
  const edge = AREAS[l.id];
  return !!edge && edge.some((p) => shapes.some((g) => inGeometry(p, g)));
}

// Straight-line metres, equirectangular — plenty for ranking.
function meters(a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * cosLat;
  const dy = b[1] - a[1];
  return 111_320 * Math.hypot(dx, dy);
}

export function landmarkReach(
  shed: Walkshed,
  tier: 11 | 45,
  origin: [number, number], // [lon, lat]
  { count = 3, only }: { count?: number; only?: (l: Landmark) => boolean } = {},
): LandmarkReach {
  const shapes = shed.features
    .filter((f) => f.properties.tier === tier)
    .map((f) => f.geometry);
  const inside: { l: Landmark; d: number }[] = [];
  const outside: { l: Landmark; d: number }[] = [];
  for (const l of LANDMARKS) {
    if (only && !only(l)) continue;
    if (EVER[l.id] === false) continue; // no ride from anywhere gets there
    const d = meters(origin, [l.lon, l.lat]);
    (reaches(l, shapes) ? inside : outside).push({ l, d });
  }
  inside.sort((a, b) => b.d - a.d); // farthest first
  outside.sort((a, b) => a.d - b.d); // nearest first
  return {
    reachable: inside.slice(0, count).map((x) => x.l),
    unreachable: outside.slice(0, count).map((x) => x.l),
  };
}

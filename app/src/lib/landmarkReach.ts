// Which landmarks a pick's walkshed reaches. The story's reflect step names the
// farthest few landmarks inside the ≤11-minute shed and the nearest few outside
// it ("You can get to A, B and C, but not D, E or F."); the compare step names
// the farthest iconic (tier 1) ones the ≤45-minute shed reaches.
//
// Cheap enough to do per pick at runtime: 87 points against one shed with a
// plain ray-cast, no precomputation.

import type { MultiPolygon, Polygon, Position } from "geojson";
import { LANDMARKS, type Landmark } from "../data/landmarks";
import type { Walkshed } from "./walksheds";

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
    const p: [number, number] = [l.lon, l.lat];
    const d = meters(origin, p);
    (shapes.some((g) => inGeometry(p, g)) ? inside : outside).push({ l, d });
  }
  inside.sort((a, b) => b.d - a.d); // farthest first
  outside.sort((a, b) => a.d - b.d); // nearest first
  return {
    reachable: inside.slice(0, count).map((x) => x.l),
    unreachable: outside.slice(0, count).map((x) => x.l),
  };
}

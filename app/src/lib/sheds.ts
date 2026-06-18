// Shed data access + contour configuration.
//
// Sheds are per-station GeoJSON FeatureCollections, each containing one polygon
// per contour (minutes of biking). They're fetched lazily on station click from
// PUBLIC_SHEDS_BASE_URL, which defaults to the public Supabase storage bucket but
// can be overridden (e.g. /sheds for fully-local development).

import type { FeatureCollection } from "geojson";

const DEFAULT_SHEDS_BASE_URL =
  "https://kevndteqglsoslznrntz.supabase.co/storage/v1/object/public/ta-citibike-price/bikesheds";

export const SHEDS_BASE_URL = (
  import.meta.env.PUBLIC_SHEDS_BASE_URL || DEFAULT_SHEDS_BASE_URL
).replace(/\/$/, "");

// The contours produced by compute_bikesheds.py, fastest first.
export const CONTOURS = [
  { minutes: 11, color: "#10b981", label: "11 min" }, // emerald
  { minutes: 45, color: "#6366f1", label: "45 min" }, // indigo
] as const;

export type ContourMinutes = (typeof CONTOURS)[number]["minutes"];

const cache = new Map<string, Promise<FeatureCollection>>();

export function fetchShed(stationId: string): Promise<FeatureCollection> {
  let p = cache.get(stationId);
  if (!p) {
    p = fetch(`${SHEDS_BASE_URL}/${stationId}.geojson`).then((res) => {
      if (!res.ok) throw new Error(`No shed for station ${stationId} (${res.status})`);
      return res.json() as Promise<FeatureCollection>;
    });
    cache.set(stationId, p);
  }
  return p;
}

// Routed-trip data access.
//
// For each origin station we precompute the bike route to every reachable
// destination (see route_trips.py). Geometries are polyline-encoded (precision
// 5) and keyed by destination station id, split into the ≤11-min and ≤45-min
// tiers (the 45 set is a superset of 11). Fetched lazily on click from
// PUBLIC_ROUTES_BASE_URL, which defaults to the public Supabase bucket but can
// be overridden (e.g. /routes-data for local development).

const DEFAULT_ROUTES_BASE_URL =
  "https://kevndteqglsoslznrntz.supabase.co/storage/v1/object/public/ta-citibike-price/routes";

export const ROUTES_BASE_URL = (
  import.meta.env.PUBLIC_ROUTES_BASE_URL || DEFAULT_ROUTES_BASE_URL
).replace(/\/$/, "");

// Per-station routes file. "11"/"45" map destination station id -> polyline.
export interface Routes {
  station_id: string;
  origin: [number, number]; // [lon, lat]
  precision: number;
  "11": Record<string, string>;
  "45": Record<string, string>;
}

const cache = new Map<string, Promise<Routes | null>>();

// Returns null when a station has no routes file yet (e.g. not routed/uploaded).
export function fetchRoutes(stationId: string): Promise<Routes | null> {
  let p = cache.get(stationId);
  if (!p) {
    p = fetch(`${ROUTES_BASE_URL}/${stationId}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<Routes>) : null))
      .catch(() => null);
    cache.set(stationId, p);
  }
  return p;
}

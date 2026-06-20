// Reachability data access + tier configuration.
//
// For each station we precompute which OTHER stations are reachable within an
// 11-min and 45-min bicycle ride (see compute_shed_mapping.py). The lists are
// stored one small JSON per station and fetched lazily on click from
// PUBLIC_REACH_BASE_URL, which defaults to the public Supabase storage bucket
// but can be overridden (e.g. /reach for fully-local development).

const DEFAULT_REACH_BASE_URL =
  "https://kevndteqglsoslznrntz.supabase.co/storage/v1/object/public/ta-citibike-price/reachable";

export const REACH_BASE_URL = (
  import.meta.env.PUBLIC_REACH_BASE_URL || DEFAULT_REACH_BASE_URL
).replace(/\/$/, "");

// Reachability tiers, fastest first. Colors are used to paint station circles.
export const CONTOURS = [
  { minutes: 11, color: "#10b981", label: "Reachable ≤ 11 min" }, // emerald
  { minutes: 45, color: "#6366f1", label: "Reachable ≤ 45 min" }, // indigo
] as const;

export type ContourMinutes = (typeof CONTOURS)[number]["minutes"];

// Shape of a per-station reachability file: lists of reachable station ids.
// "45" is a superset of "11"; the origin station is excluded from both.
export interface Reach {
  "11": string[];
  "45": string[];
}

const cache = new Map<string, Promise<Reach>>();

export function fetchReach(stationId: string): Promise<Reach> {
  let p = cache.get(stationId);
  if (!p) {
    p = fetch(`${REACH_BASE_URL}/${stationId}.json`).then((res) => {
      if (!res.ok)
        throw new Error(`No reachability for station ${stationId} (${res.status})`);
      return res.json() as Promise<Reach>;
    });
    cache.set(stationId, p);
  }
  return p;
}

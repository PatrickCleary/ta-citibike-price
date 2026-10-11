// Walkshed layer for the map.
//
// For each origin we precompute one shape per tier: the union of the 5-minute
// walk sheds around the origin and every station reachable within 11 / 45 min
// (see compute_walksheds.py). The story fades a tier's shed in once that tier's
// trip lines have finished drawing out, in the same colour as the lines.
//
// Fetched lazily per pick from PUBLIC_WALKSHED_BASE_URL, which defaults to
// /walkshed_unions (a local symlink into the pipeline output, see app/.gitignore).

import type { FilterSpecification, GeoJSONSource, Map } from "maplibre-gl";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { DOCKS_LAYER } from "./dockController";
import { COLOR_ALL, COLOR_NEAR } from "./tripLines";
import type { StepKey } from "./store";

const WALKSHED_BASE_URL = (
  import.meta.env.PUBLIC_WALKSHED_BASE_URL || "/walkshed_unions"
).replace(/\/$/, "");

export type Walkshed = FeatureCollection<
  Polygon | MultiPolygon,
  { tier: 11 | 45 }
>;

// Returns null when a station has no walkshed file yet.
export function fetchWalkshed(stationId: string): Promise<Walkshed | null> {
  return fetch(`${WALKSHED_BASE_URL}/${stationId}.geojson`)
    .then((res) => (res.ok ? (res.json() as Promise<Walkshed>) : null))
    .catch(() => null);
}

const SOURCE = "walkshed";
const EMPTY: Walkshed = { type: "FeatureCollection", features: [] };
const FADE_MS = 900;

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

// One fill + outline per step. Near is the ≤11 shed in the near lines' orange;
// far is the ≤45 shed in the far lines' indigo (the far step recolours every
// line blue, so its shed does too).
export const TIERS: Record<StepKey, { tier: 11 | 45; color: string; fill: number }> = {
  near: { tier: 11, color: rgb(COLOR_NEAR), fill: 0.22 },
  far: { tier: 45, color: rgb(COLOR_ALL), fill: 0.18 },
};
const LINE_OPACITY = 0.9;

const fillId = (key: StepKey) => `walkshed-${key}-fill`;
const lineId = (key: StepKey) => `walkshed-${key}-line`;

export class WalkshedLayer {
  private shown = "";

  // Construct before TripLines: both slot under the dock layer, so adding these
  // first leaves the trip lines drawn on top of the shed.
  constructor(private map: Map) {
    map.addSource(SOURCE, { type: "geojson", data: EMPTY });
    for (const key of ["far", "near"] as StepKey[]) {
      const { tier, color } = TIERS[key];
      const filter: FilterSpecification = ["==", ["get", "tier"], tier];
      const fade = { duration: FADE_MS, delay: 0 };
      map.addLayer(
        {
          id: fillId(key),
          type: "fill",
          source: SOURCE,
          filter,
          paint: {
            "fill-color": color,
            "fill-opacity": 0,
            "fill-opacity-transition": fade,
          },
        },
        DOCKS_LAYER,
      );
      map.addLayer(
        {
          id: lineId(key),
          type: "line",
          source: SOURCE,
          filter,
          paint: {
            "line-color": color,
            "line-width": 1.5,
            "line-opacity": 0,
            "line-opacity-transition": fade,
          },
        },
        DOCKS_LAYER,
      );
    }
  }

  // Swap in a pick's sheds (or null to clear). Visibility is left as-is, so a
  // file that lands after a draw-out finished still fades in.
  setData(data: Walkshed | null) {
    this.source()?.setData(data ?? EMPTY);
  }

  // Fade `key`'s shed in and the other out; null fades both out. Idempotent, so
  // it's safe to call every frame.
  show(key: StepKey | null) {
    this.showTiers({ near: key === "near", far: key === "far" });
  }

  // Fade each tier's shed in or out independently (near draws over far).
  showTiers(on: Record<StepKey, boolean>) {
    const tag = `${on.near}/${on.far}`;
    if (tag === this.shown) return;
    this.shown = tag;
    for (const k of ["near", "far"] as StepKey[]) {
      if (this.map.getLayer(fillId(k))) {
        this.map.setPaintProperty(fillId(k), "fill-opacity", on[k] ? TIERS[k].fill : 0);
        this.map.setPaintProperty(lineId(k), "line-opacity", on[k] ? LINE_OPACITY : 0);
      }
    }
  }

  private source() {
    return this.map.getSource(SOURCE) as GeoJSONSource | undefined;
  }
}

// [[w, s], [e, n]] around the given tiers' sheds, or null if none are present.
export function walkshedBounds(
  data: Walkshed,
  tiers: (11 | 45)[],
): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const [x, y] = c as [number, number];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else (c as unknown[]).forEach(visit);
  };
  for (const f of data.features) {
    if (tiers.includes(f.properties.tier)) visit(f.geometry.coordinates);
  }
  return w === Infinity ? null : [[w, s], [e, n]];
}

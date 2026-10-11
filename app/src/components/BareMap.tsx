import { useCallback, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import polyline from "@mapbox/polyline";
import type {
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
} from "geojson";
import {
  Layer,
  Map as MaplibreMap,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from "react-map-gl/maplibre";
import { BRAND_ORANGE, FULL_VIEW } from "../lib/constants";
import { DOCKS_LAYER } from "../lib/dockController";
import { COLOR_ALL, COLOR_NEAR } from "../lib/tripLines";
import { fetchRoutes, type Routes } from "../lib/trips";

const STADIA_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;
const STYLE_URL = "/data/custom_adilade_no_labels.json";

const transformRequest: maplibregl.RequestTransformFunction = (url) => {
  if (STADIA_KEY && url.includes("stadiamaps.com")) {
    return {
      url: `${url}${url.includes("?") ? "&" : "?"}api_key=${STADIA_KEY}`,
    };
  }
  return { url };
};

// Merged 5-min walk sheds around each origin's reachable stations, one feature
// per tier (see compute_walksheds.py). Served from public/walkshed_unions in dev.
const WALKSHED_BASE_URL = (
  import.meta.env.PUBLIC_WALKSHED_BASE_URL || "/walkshed_unions"
).replace(/\/$/, "");

type Walkshed = FeatureCollection<Polygon | MultiPolygon, { tier: 11 | 45 }>;

// Null when the station has no walk shed file yet.
const fetchWalkshed = (id: string): Promise<Walkshed | null> =>
  fetch(`${WALKSHED_BASE_URL}/${id}.geojson`)
    .then((res) => (res.ok ? (res.json() as Promise<Walkshed>) : null))
    .catch(() => null);

// Both overlay sources stay mounted (empty when unused) so their layers keep a
// fixed stacking order: walk shed under trip lines under dots.
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

type Lines = FeatureCollection<LineString, { near: boolean }>;

// Decode a station's routes into one line per destination. The 45 set is a
// superset of 11, so each destination appears once, flagged by tier.
function toLines(routes: Routes): Lines {
  const features: Lines["features"] = [];
  for (const [dest, encoded] of Object.entries(routes["45"])) {
    // polyline decodes to [lat, lng]; GeoJSON wants [lng, lat].
    const coordinates = polyline
      .decode(encoded, routes.precision)
      .map(([lat, lng]) => [lng, lat]);
    if (coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { near: dest in routes["11"] },
      geometry: { type: "LineString", coordinates },
    });
  }
  return { type: "FeatureCollection", features };
}

function boundsOf(lines: Lines, origin: [number, number]) {
  let [minX, minY, maxX, maxY] = [origin[0], origin[1], origin[0], origin[1]];
  for (const f of lines.features) {
    for (const [x, y] of f.geometry.coordinates) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ] as [[number, number], [number, number]];
}

// Basemap, static station dots, and trip lines: click a station to draw every
// one of its routed trips at once (≤11 min in orange over the ≤45 band), over
// its merged walk shed where one has been computed.
export default function BareMap() {
  const mapRef = useRef<MapRef>(null);
  const pickRef = useRef<string | null>(null); // guards stale route fetches
  const [lines, setLines] = useState<Lines | null>(null);
  const [walkshed, setWalkshed] = useState<Walkshed | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.station_id;
    if (typeof id !== "string") return;
    pickRef.current = id;
    setLoading(true);

    const [routes, shed] = await Promise.all([
      fetchRoutes(id),
      fetchWalkshed(id),
    ]);
    if (pickRef.current !== id) return; // a newer click won
    setLoading(false);
    setWalkshed(shed);
    if (!routes) return setLines(null);
    const next = toLines(routes);
    setLines(next);
    mapRef.current?.fitBounds(boundsOf(next, routes.origin), {
      padding: 60,
      duration: 800,
    });
  }, []);

  return (
    <div className="fixed inset-0">
      <MaplibreMap
        ref={mapRef}
        mapStyle={STYLE_URL}
        initialViewState={{
          latitude: FULL_VIEW.center[1],
          longitude: FULL_VIEW.center[0],
          zoom: FULL_VIEW.zoom,
        }}
        transformRequest={transformRequest}
        interactiveLayerIds={[DOCKS_LAYER]}
        cursor={loading ? "progress" : undefined}
        onClick={handleClick}
        dragRotate={false}
        touchPitch={false}
      >
        <Source id="stations" type="geojson" data="/stations.geojson">
          <Layer
            id={DOCKS_LAYER}
            type="circle"
            paint={{
              "circle-color": BRAND_ORANGE,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
              "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                10, 2.5,
                15, 6,
              ],
            }}
          />
        </Source>

        <Source id="walkshed" type="geojson" data={walkshed ?? EMPTY}>
          {/* Under the trip lines; the ≤11 shed sits inside the ≤45 one. */}
          <Layer
            id="walkshed-far"
            type="fill"
            beforeId={DOCKS_LAYER}
            filter={["==", ["get", "tier"], 45]}
            paint={{ "fill-color": rgb(COLOR_ALL), "fill-opacity": 0.18 }}
          />
          <Layer
            id="walkshed-near"
            type="fill"
            beforeId={DOCKS_LAYER}
            filter={["==", ["get", "tier"], 11]}
            paint={{ "fill-color": rgb(COLOR_NEAR), "fill-opacity": 0.25 }}
          />
          <Layer
            id="walkshed-outline"
            type="line"
            beforeId={DOCKS_LAYER}
            paint={{
              "line-color": [
                "match", ["get", "tier"],
                11, rgb(COLOR_NEAR),
                rgb(COLOR_ALL),
              ],
              "line-width": 1.5,
            }}
          />
        </Source>

        <Source id="trip-lines" type="geojson" data={lines ?? EMPTY}>
          {/* Slotted under the dots; near drawn last so it sits on top. */}
          <Layer
            id="trip-lines-far"
            type="line"
            beforeId={DOCKS_LAYER}
            filter={["!", ["get", "near"]]}
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              "line-color": rgb(COLOR_ALL),
              "line-width": 1.5,
              "line-opacity": 0.4,
            }}
          />
          <Layer
            id="trip-lines-near"
            type="line"
            beforeId={DOCKS_LAYER}
            filter={["get", "near"]}
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              "line-color": rgb(COLOR_NEAR),
              "line-width": 2,
              "line-opacity": 0.8,
            }}
          />
        </Source>
      </MaplibreMap>
    </div>
  );
}

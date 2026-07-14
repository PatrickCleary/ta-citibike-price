import { useCallback, useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONTOURS } from "../lib/sheds";
import {
  DockController,
  stationPaint,
  STATIONS_SOURCE as DOCKS_SOURCE,
  STATIONS_LAYER as DOCKS_LAYER,
  type StationPoint,
} from "../lib/dockController";
import { TripLines } from "../lib/tripLines";
import { useApp } from "../lib/store";
import { useReach, useRoutes } from "../lib/queries";
import { useSelectStation } from "../lib/mapControl";
import { useMapStore } from "../lib/mapStore";
import { StoryController } from "../lib/storyController";
import { registerMapHandlers } from "../lib/handlers";
import { FULL_VIEW } from "../lib/constants";
import Narrator from "./Narrator";

const STADIA_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;
// Custom "Alidade Smooth, no labels" style. Its tiles/sprite are served by
// Stadia (keyless on localhost); transformRequest appends the API key in prod.
const STYLE_URL = "/data/custom_adilade_no_labels.json";

const transformRequest: maplibregl.RequestTransformFunction = (url) => {
  if (STADIA_KEY && url.includes("stadiamaps.com")) {
    return {
      url: `${url}${url.includes("?") ? "&" : "?"}api_key=${STADIA_KEY}`,
    };
  }
  return { url };
};

// One react-query client for the whole island.
const queryClient = new QueryClient();

export default function Map() {
  return (
    <QueryClientProvider client={queryClient}>
      <MapView />
    </QueryClientProvider>
  );
}

function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const docksRef = useRef<DockController | null>(null);
  const tripsRef = useRef<TripLines | null>(null);
  const storyRef = useRef<StoryController | null>(null); // animation clock
  const introRef = useRef(false); // intro ripple already played?
  const coordsRef = useRef(new globalThis.Map<string, [number, number]>()); // id → [lng, lat]
  const selectStation = useSelectStation();

  // Discrete control state lives in the store; server data in react-query.
  const selected = useApp((s) => s.selected);
  const phase = useApp((s) => s.phase);

  const reachQuery = useReach(selected?.id ?? null);
  const routesQuery = useRoutes(selected?.id ?? null);

  // Ripple the whole station field in, once stations + layer are both ready.
  const playIntro = useCallback(() => {
    const docks = docksRef.current;
    const map = mapRef.current;
    if (introRef.current || !docks || !map?.getLayer(DOCKS_LAYER)) return;
    if (coordsRef.current.size === 0) return; // stations not loaded yet
    introRef.current = true;
    docks.appearAll(FULL_VIEW.center);
    docks.start();
  }, []);

  // --- one-time map setup -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    let unregisterHandlers: (() => void) | null = null;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: FULL_VIEW.center,
      zoom: FULL_VIEW.zoom,
      transformRequest,
    });
    mapRef.current = map;
    docksRef.current = new DockController(map);
    tripsRef.current = new TripLines(map);
    storyRef.current = new StoryController(
      map,
      tripsRef.current,
      docksRef.current,
      (id) => coordsRef.current.get(id) ?? null,
      () => useApp.getState().selected?.id ?? null,
    );
    // Publish the imperative objects so hooks (selectStation, resetMap) can
    // reach them from anywhere without prop-drilling a ref.
    useMapStore.getState().setMap(map);
    useMapStore.getState().setDocks(docksRef.current);
    useMapStore.getState().setStory(storyRef.current);
    // Pan/zoom stay enabled (defaults) so the intro is explorable; they're
    // locked while the camera-driven story plays. Rotation/pitch stay off (2D).
    map.dragRotate.disable();
    map.touchPitch.disable();

    fetch("/stations.geojson")
      .then((r) => r.json())
      .then((fc) => {
        const list: StationPoint[] = [];
        for (const f of fc.features) {
          const id = f.properties?.station_id;
          const [lon, lat] = f.geometry?.coordinates ?? [];
          if (typeof id === "string" && typeof lon === "number") {
            list.push({ id, lon, lat });
            coordsRef.current.set(id, [lon, lat]);
          }
        }
        docksRef.current?.setStations(list);
        playIntro();
      })
      .catch(() => {});

    map.on("load", () => {
      map.addSource(DOCKS_SOURCE, {
        type: "geojson",
        data: "/stations.geojson",
        promoteId: "station_id",
      });
      map.addLayer({
        id: DOCKS_LAYER,
        type: "circle",
        source: DOCKS_SOURCE,
        paint: stationPaint(),
      });

      // Pick + hover-cursor handlers, bound only while the phase is `intro`.
      unregisterHandlers = registerMapHandlers(map, selectStation);

      // Station layer now exists → paint the intro frame and (once stations
      // have also loaded) ripple the field in.
      storyRef.current?.showIntro();
      playIntro();
    });

    return () => {
      unregisterHandlers?.();
      storyRef.current?.dispose();
      docksRef.current?.dispose();
      tripsRef.current?.dispose();
      map.remove();
      useMapStore.getState().setMap(null);
      useMapStore.getState().setDocks(null);
      useMapStore.getState().setStory(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New pick (or deselect) → reset the per-pick latch so the next pick re-applies
  // origin styling from a clean slate; clear the trip lines on deselect.
  useEffect(() => {
    storyRef.current?.resetPick();
    if (!selected) tripsRef.current?.clear();
  }, [selected]);

  // Landing on a step paints its static resting frame. Draw-out animations are
  // triggered separately by the UI's play buttons (story.playNear/playFar).
  useEffect(() => {
    const story = storyRef.current;
    if (!story) return;
    switch (phase) {
      case "intro":
        story.showIntro();
        break;
      case "selected":
        story.showOrigin();
        break;
      case "near":
        story.holdNear();
        break;
      case "far":
      case "final":
        story.holdFar();
        break;
    }
  }, [phase]);

  // Routes for the pick arrived → hand them to the trip lines so they're ready
  // to draw when the UI triggers a step. A station with no routes file (data
  // null) simply has nothing to animate.
  useEffect(() => {
    if (!selected || !routesQuery.isSuccess) return;
    const routes = routesQuery.data;
    if (!routes) return;
    tripsRef.current?.show(routes);
  }, [selected, routesQuery.isSuccess, routesQuery.data]);

  const reach = reachQuery.data;
  const counts: Record<number, number> | null = reach
    ? { 11: reach["11"].length, 45: reach["45"].length }
    : null;
  const error = reachQuery.error
    ? reachQuery.error instanceof Error
      ? reachQuery.error.message
      : String(reachQuery.error)
    : null;

  return (
    <>
      {/* Full-screen map behind everything. */}
      <div className="fixed inset-0">
        <div ref={containerRef} className="h-full w-full" />

        {/* Legend (color key + counts) */}
        <div className="absolute left-4 top-4 max-w-xs rounded-lg bg-white/90 p-4 shadow-lg backdrop-blur">
          <h1 className="text-base font-semibold text-gray-900">
            Citi Bike Sheds
          </h1>
          <p className="mt-1 text-sm text-gray-600">{selected?.name ?? "…"}</p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 space-y-1">
            {CONTOURS.map((c) => (
              <div
                key={c.minutes}
                className="flex items-center gap-2 text-xs text-gray-600"
              >
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                {c.label}
                {counts && (
                  <span className="ml-auto font-medium text-gray-900">
                    {counts[c.minutes]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Intro prompt — shown until a station is picked. */}
      {!selected && (
        <div className="pointer-events-none fixed inset-x-0 top-24 flex justify-center px-4">
          <div className="max-w-xl rounded-xl bg-white/85 px-6 py-4 text-center shadow-lg backdrop-blur">
            <span className="block text-2xl font-semibold text-gray-900">
              Where can a Citi Bike take you?
            </span>
            <span className="mt-2 block text-base text-gray-600">
              Click any station to ride out from it.
            </span>
          </div>
        </div>
      )}

      {/* Step caption + prev/next controls — phase-driven, shown during the story. */}
      <Narrator />
    </>
  );
}

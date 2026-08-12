import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONTOURS } from "../lib/sheds";
import {
  DockController,
  stationPaint,
  stationHaloPaint,
  loadDockIcon,
  DOCKS_SOURCE,
  DOCKS_PIN_SOURCE,
  DOCKS_LAYER,
  DOCKS_ICON_LAYER,
  DOCKS_HALO_LAYER,
  ZOOM_CIRCLE,
  ZOOM_BUBBLE_FULL,
  type StationPoint,
  stationIconPaint,
  stationIconLayout,
} from "../lib/dockController";
import StationBubbles from "./StationBubble";
import { TripLines } from "../lib/tripLines";
import { useApp } from "../lib/store";
import { useReach, useRoutes } from "../lib/queries";
import { useSelectStation } from "../lib/mapControl";
import { useMapStore } from "../lib/mapStore";
import { StoryController } from "../lib/storyController";
import { registerMapHandlers } from "../lib/handlers";
import { FULL_VIEW } from "../lib/constants";
import Narrator from "./Narrator";
import { SearchBar, type Suggestion } from "./SearchBar";

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
  // Same docks the controller drives, but in React's hands — the bubble layer is
  // DOM, so it needs the list (names included) rather than a map source.
  const [stations, setStations] = useState<StationPoint[]>([]);
  const selectStation = useSelectStation();
  const { setMap, setDocks, setStory } = useMapStore();

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

  const handleSelect = useCallback((result: Suggestion) => {
    mapRef.current?.flyTo({
      center: [result.lon, result.lat],
      zoom: result.type === 'station' ? 16 : 15,
      duration: 800,
    });

    if (result.type === 'station') {
      // e.g. open a popup on that station's marker
      selectStation({ id: result.id, name: result.label, lon: result.lon, lat: result.lat });
    } else {
      // e.g. drop a temporary pin
      new maplibregl.Marker().setLngLat([result.lon, result.lat]).addTo(mapRef.current!);
    }
  }, []);

  // --- one-time map setup -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    let unregisterHandlers: (() => void) | null = null;
    let disposed = false; // guards the async icon load against unmount
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
    setMap(map);
    setDocks(docksRef.current);
    setStory(storyRef.current);
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
          const name = f.properties?.name;
          const [lon, lat] = f.geometry?.coordinates ?? [];
          if (
            typeof id === "string" &&
            typeof name === "string" &&
            typeof lon === "number"
          ) {
            list.push({ id, name, lon, lat });
            coordsRef.current.set(id, [lon, lat]);
          }
        }
        docksRef.current?.setStations(list);
        setStations(list);
        playIntro();
      })
      .catch(() => {});

    map.on("load", async () => {
      map.addSource(DOCKS_SOURCE, {
        type: "geojson",
        data: "/stations.geojson",
        promoteId: "station_id",
        // Both of these exist for the region heatmap, which can only draw docks
        // that are in a LOADED tile. Its radius is geographic (~500m), so a
        // pixel's colour depends on docks well outside the viewport — and by
        // default the tiles holding them simply aren't loaded once you zoom in.
        // The region then starves and flickers as tiles come and go.
        //
        // maxzoom 13 stops subdividing there and overzooms above it, so a close
        // view reuses a ~5km tile that still contains every dock that could feed
        // it. buffer 512 (the max, ~613m at z13) then covers docks just outside
        // that tile, so the region doesn't seam at tile edges either.
        // Points aren't simplified, so the dots and pins are unaffected.
        maxzoom: 13,
        buffer: 512,
      });
      // The same docks again, tiled normally — for the pins only. They can't
      // share DOCKS_SOURCE: its maxzoom 13 is what the heatmap needs, but it
      // means a zoom-16 view is served by one overzoomed ~5km tile containing
      // every dock inside it. The circle layer shrugs that off (no placement
      // pass); the symbol layer was placing hundreds of pins to draw ~20. With
      // default tiling a z16 view loads z16 tiles, so it places ~20.
      //
      // No promoteId: the pins are deliberately feature-state-free (see
      // iconOpacityExpr), so this source never needs a state write.
      map.addSource(DOCKS_PIN_SOURCE, {
        type: "geojson",
        data: "/stations.geojson",
      });
      // The region under everything: added before the dots so the trip lines
      // (which insert with beforeId: DOCKS_LAYER) land between the two.
      map.addLayer({
        id: DOCKS_HALO_LAYER,
        type: "heatmap",
        source: DOCKS_SOURCE,
        paint: stationHaloPaint(),
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

      // Pins are a second look at the same docks: a symbol layer over the same
      // source and feature-state, cross-faded against the dots by zoom (see
      // dockController). Added last so rasterizing the SVG never delays the
      // clickable field — until it lands, the dots simply carry the whole map.
      // Clicks keep hitting the circle layer either way; a zero-opacity circle
      // is still queryable, so the pin layer stays purely cosmetic.
      try {
        await loadDockIcon(map);
        if (disposed) return;
        map.addLayer({
          id: DOCKS_ICON_LAYER,
          type: "symbol",
          source: DOCKS_PIN_SOURCE,
          // Load-bearing for performance, not just for looks. icon-opacity is
          // PAINT, so the cross-fade hides the pins below ZOOM_CIRCLE but still
          // lays out and places all ~2.4k of them on every camera frame — the
          // whole intro (zoom 10.3) was paying full symbol cost to draw nothing.
          // minzoom drops the layer entirely instead. Keep it in sync with the
          // bottom stop of iconOpacityExpr, where the pins are still at 0.
          minzoom: ZOOM_CIRCLE,
          // The same trick at the top end, where the bubbles have taken over —
          // matches the last stop of iconOpacityExpr, which is also 0.
          maxzoom: ZOOM_BUBBLE_FULL,
          layout: stationIconLayout(),
          paint: stationIconPaint(),
        });
      } catch (e) {
        // No pins — the dot field is a complete map on its own, so this is
        // survivable. Still loud: a bad icon expression fails exactly here, and
        // silently losing the layer looks identical to "zoomed out too far".
        console.error("dock pin layer unavailable", e);
      }
    });

    return () => {
      disposed = true;
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
        {/* The dock's third look — DOM markers, zoom-gated (StationBubble.tsx). */}
        <StationBubbles stations={stations} />
      </div>

      <div className="pointer-events-none fixed inset-x-0 top-3 left-3 flex justify-center px-4">
        <MapHeader />
      </div>
      {/* Step caption + prev/next controls — phase-driven, shown during the story. */}
      <Narrator />

      <SearchBar stations={stations} mapCenter={mapRef.current?.getCenter()} onSelect={handleSelect} />
    </>
  );
}

const MapHeader: React.FC = () => {
  // One selector per field. A selector returning an object literal builds a new
  // reference every run, and zustand v5 compares snapshots by identity — so it
  // would re-render, reselect, and loop until React bails out.
  const phase = useApp((s) => s.phase);
  const selected = useApp((s) => s.selected);

  if (phase === "intro" || !selected)
    return (
      <div className="rounded-xl bg-white/85 px-6 py-4 shadow-lg backdrop-blur">
        <span className="block text-2xl font-semibold text-gray-900">
          Where can a Citi Bike take you?
        </span>
        <span className="mt-2 block text-base text-gray-600">
          Click any station to ride out from it — or, search for a station or address
        </span>
      </div>
    );
  if (phase === "near")
    return (
      <div className="rounded-xl bg-white/85 px-6 py-4 shadow-lg backdrop-blur">
        <span className="block text-2xl font-semibold text-gray-900">
          This is how far a $3.00 ride on a Citi Bike can take you
          currently. {" "}
        </span>
      </div>
    );
    
  return null;
};

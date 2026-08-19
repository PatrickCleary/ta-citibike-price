import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type MapLayerMouseEvent,
  type MapLibreEvent,
} from "maplibre-gl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useMeasure from "react-use-measure";
import {
  DockController,
  stationPaint,
  stationHaloPaint,
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
  loadDockIcon,
} from "../lib/dockController";
import StationBubbles from "./StationBubble";
import { TripLines } from "../lib/tripLines";
import { useApp, useHover } from "../lib/store";
import { useReach, useRoutes } from "../lib/queries";
import { useSelectStation } from "../lib/mapControl";
import { useMapStore } from "../lib/mapStore";
import { StoryController } from "../lib/storyController";
import { toStation } from "../lib/handlers";
import { FULL_VIEW } from "../lib/constants";
import Narrator from "./Narrator";
import { SearchBar } from "./SearchBar";
import { useIsMobile } from "../lib/useIsMobile";
import { motion } from "motion/react";
import type { FeatureCollection, Point } from "geojson";
import {
  Layer,
  Map as MaplibreMap,
  Source,
  type MapRef,
} from "react-map-gl/maplibre";
import type { Suggestion } from "../lib/geocodeSearch";

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

type StationProperties = { station_id: string; name: string };

export default function MapComponent({
  serverData,
}: {
  serverData: FeatureCollection<Point, StationProperties>;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MapView serverData={serverData} />
    </QueryClientProvider>
  );
}

function MapView({
  serverData,
}: {
  serverData: FeatureCollection<Point, StationProperties>;
}) {
  const mapRef = useRef<MapRef>(null);
  const [intro, setIntro] = useState(false); // intro ripple already played?
  const markerRef = useRef<maplibregl.Marker>(null);
  const docksRef = useRef<DockController>(null);
  const tripsRef = useRef<TripLines>(null);
  const storyRef = useRef<StoryController>(null);

  const features = useMemo(
    () =>
      serverData.features.map((f) => {
        const id = f.properties.station_id;
        const name = f.properties.name;
        const [lon, lat] = f.geometry.coordinates;
        return { id, name, lon, lat };
      }),
    [serverData],
  );
  const coords: Map<string, [number, number]> = useMemo(
    () => new Map(features.map((s) => [s.id, [s.lon, s.lat]])),
    [features],
  );
  const stationsByName = useMemo(
    () => new Map(features.map((f) => [f.name, f])),
    [features],
  );

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

  const isMobile = useIsMobile();

  // Ripple the whole station field in, once stations + layer are both ready.
  const playIntro = useCallback(() => {
    const docks = docksRef.current;
    const map = mapRef.current;
    if (intro || !docks || !map?.getLayer(DOCKS_LAYER)) return;
    setIntro(true);
    docks.appearAll(FULL_VIEW.center);
    docks.start();
  }, []);

  const handleMapLoad = useCallback(async (event: MapLibreEvent) => {
    const map = event.target;

    // load icon
    loadDockIcon(map);

    // set up controllers
    docksRef.current = new DockController(map);
    tripsRef.current = new TripLines(map);
    storyRef.current = new StoryController(
      map,
      tripsRef.current,
      docksRef.current,
      (id) => coords.get(id) ?? null,
      () => useApp.getState().selected?.id ?? null,
    );

    // Publish the imperative objects so hooks (selectStation, resetMap) can
    // reach them from anywhere without prop-drilling a ref.
    setMap(map);
    setDocks(docksRef?.current);
    setStory(storyRef?.current);

    docksRef.current?.setStations(features);
    setStations(features);

    // start intro
    storyRef.current?.showIntro();
    playIntro();
  }, []);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const station = toStation(e.features?.[0]);
      if (station) selectStation(station);
    },
    [selectStation],
  );

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    e.target.getCanvas().style.cursor = "pointer";
    const id = e.features?.[0]?.properties?.station_id;
    useHover.getState().setHovered(typeof id === "string" ? id : null);
  }, []);

  const handleMouseLeave = useCallback((e: MapLayerMouseEvent) => {
    e.target.getCanvas().style.cursor = "";
    useHover.getState().setHovered(null);
  }, []);

  const handleSelect = useCallback((result: Suggestion) => {
    if (result.id && result.label && result.lon && result.lat) {
      mapRef.current?.flyTo({
        center: [result.lon, result.lat],
        zoom: result.type === "station" ? 16 : 15,
        duration: 800,
      });

      markerRef.current?.remove();
      markerRef.current = null;

      if (result.type === "station") {
        const actualStation = stationsByName.get(result.stationName ?? "");
        if (actualStation) {
          selectStation({
            id: actualStation.id,
            name: actualStation.name,
            lon: actualStation.lon,
            lat: actualStation.lat,
          });
        }
      } else {
        markerRef.current = new maplibregl.Marker()
          .setLngLat([result.lon, result.lat])
          .addTo(mapRef.current!.getMap());
      }
    }
  }, []);

  // clean up controllers on unmount
  useEffect(() => {
    return () => {
      storyRef.current?.dispose();
      docksRef.current?.dispose();
      tripsRef.current?.dispose();
    };
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

  const [ref, { height }] = useMeasure();

  return (
    <>
      {/* Full-screen map behind everything. */}
      <div className="fixed inset-0">
        <div className="h-full w-full">
          <MaplibreMap
            ref={mapRef}
            interactiveLayerIds={[DOCKS_ICON_LAYER]}
            mapStyle={STYLE_URL}
            initialViewState={{
              latitude: FULL_VIEW.center[1],
              longitude: FULL_VIEW.center[0],
              zoom: FULL_VIEW.zoom,
            }}
            padding={{ top: isMobile ? 250 : 0, bottom: 0, left: 0, right: 0 }}
            transformRequest={transformRequest}
            onLoad={handleMapLoad}
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            dragRotate={false}
            touchPitch={false}
          >
            <Source
              id={DOCKS_SOURCE}
              type="geojson"
              data="/stations.geojson"
              promoteId="station_id"
              maxzoom={13}
              buffer={512}
            >
              <Layer id={DOCKS_LAYER} type="circle" paint={stationPaint(0)} />
              <Layer
                id={DOCKS_HALO_LAYER}
                type="heatmap"
                paint={stationHaloPaint()}
              />
            </Source>
            <Source
              id={DOCKS_PIN_SOURCE}
              type="geojson"
              data="/stations.geojson"
            >
              <Layer
                id={DOCKS_ICON_LAYER}
                type="symbol"
                minzoom={ZOOM_CIRCLE}
                maxzoom={ZOOM_BUBBLE_FULL}
                layout={stationIconLayout()}
                paint={stationIconPaint()}
              />
            </Source>
          </MaplibreMap>
        </div>
        {/* The dock's third look — DOM markers, zoom-gated (StationBubble.tsx). */}
        <StationBubbles stations={stations} />
      </div>

      <div className="fixed inset-0 pointer-events-none">
        <div className="m-4 flex justify-center flex flex-col gap-3 md:w-md">
          <motion.div
            // 2. Animate the parent height to match the child's height
            animate={{ height: height > 0 ? height + 24 : "auto" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            style={{ overflow: "hidden" }} // Prevents text bleeding out during animation
            className="rounded-xl bg-white/85 px-6 pt-4 pb-1 shadow-lg backdrop-blur"
          >
            <div ref={ref}>
              <span className="block text-2xl font-semibold text-gray-900">
                Where can a Citi Bike take you?
              </span>
              <Narrator />
            </div>
          </motion.div>
          {phase === "intro" && (
            <SearchBar
              mapCenter={mapRef.current?.getCenter()}
              onSelect={handleSelect}
              onClear={() => {
                markerRef.current?.remove();
                markerRef.current = null;
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

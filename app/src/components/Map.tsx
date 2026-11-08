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
  stationHitPaint,
  DOCKS_SOURCE,
  DOCKS_PIN_SOURCE,
  DOCKS_LAYER,
  DOCKS_HIT_LAYER,
  DOCKS_ICON_LAYER,
  ZOOM_CIRCLE,
  ZOOM_BUBBLE_FULL,
  type StationPoint,
  stationIconPaint,
  stationIconLayout,
  loadDockIcon,
} from "../lib/dockController";
import StationBubbles from "./StationBubble";
import Landmarks from "./Landmarks";
import { TripLines } from "../lib/tripLines";
import { useApp, useHover } from "../lib/store";
import { useReach, useRoutes, useWalkshed } from "../lib/queries";
import { useResetMap, useSelectStation } from "../lib/mapControl";
import { useMapStore } from "../lib/mapStore";
import { StoryController } from "../lib/storyController";
import { WalkshedLayer, walkshedBounds } from "../lib/walksheds";
import { toStation } from "../lib/handlers";
import {
  BRAND_ORANGE,
  COVERAGE_LINE_COLOR,
  COVERAGE_LINE_DASH,
  COVERAGE_LINE_WIDTH,
  COVERAGE_URL,
  FULL_VIEW,
} from "../lib/constants";
import Narrator, { StepLegend } from "./Narrator";
import { SearchBar } from "./SearchBar";
import { useIsMobile } from "../lib/useIsMobile";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import IntroOverlay from "./IntroOverlay";
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
  const [splash, setSplash] = useState(true); // IntroOverlay open? (on first load, or via the corner dot)
  const markerRef = useRef<maplibregl.Marker>(null);
  // A camera move to make once the intro frame has been painted (see
  // handleSelect: an address search mid-story resets to the intro first, and
  // showIntro's jump would otherwise cancel the fly).
  const pendingFlyRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const docksRef = useRef<DockController>(null);
  const tripsRef = useRef<TripLines>(null);
  const shedsRef = useRef<WalkshedLayer>(null);
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
  const resetMap = useResetMap();
  const { setMap, setDocks, setStory } = useMapStore();

  // Discrete control state lives in the store; server data in react-query.
  const selected = useApp((s) => s.selected);
  const phase = useApp((s) => s.phase);
  const layers = useApp((s) => s.layers);
  const exploring = useApp((s) => s.exploring);

  const reachQuery = useReach(selected?.id ?? null);
  const routesQuery = useRoutes(selected?.id ?? null);
  const walkshedQuery = useWalkshed(selected?.id ?? null);

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
    // Sheds before trips, so the trip lines stack on top (both sit under docks).
    shedsRef.current = new WalkshedLayer(map);
    tripsRef.current = new TripLines(map);
    storyRef.current = new StoryController(
      map,
      tripsRef.current,
      docksRef.current,
      shedsRef.current,
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
      // Bubbles are DOM markers inside the map container, so a click on one
      // also lands here after the bubble has handled it — by which time exploring
      // has already switched off, and this would restart the story. Only clicks
      // on the canvas itself are the map's to handle.
      if (e.originalEvent.target !== e.target.getCanvas()) return;
      const station = toStation(e.features?.[0]);
      if (!station) return;
      const { phase, exploring, switchStation } = useApp.getState();
      // While exploring (far step, toggled on) a click swaps the origin in place
      // — its finished far view, no restart. In the intro it starts the story.
      // Mid-story the field is hidden, so there's nothing else to pick.
      if (exploring) {
        switchStation({ id: station.id, name: station.name });
      } else if (phase === "intro") {
        selectStation(station);
      }
    },
    [selectStation],
  );

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    // Bubbles live inside the canvas container, so MapLibre still reports
    // mousemove over one — with no dock under that pixel, since the bubble
    // hangs above its dot. Leave the hover alone there: the bubble is the
    // hovered dock's own label, and clearing it would yank it out from under
    // the pointer. (Pins were tall enough to mask this; dots aren't.)
    if (e.originalEvent.target !== e.target.getCanvas()) return;
    // Pointer over anything pickable (dots, their hit pads, pins).
    e.target.getCanvas().style.cursor = e.features?.length ? "pointer" : "";
    const id = e.features?.[0]?.properties?.station_id;
    useHover.getState().setHovered(typeof id === "string" ? id : null);
  }, []);

  const handleMouseLeave = useCallback((e: MapLayerMouseEvent) => {
    e.target.getCanvas().style.cursor = "";
    useHover.getState().setHovered(null);
  }, []);

  const handleSelect = useCallback((result: Suggestion) => {
    if (result.id && result.label && result.lon && result.lat) {
      const fly = {
        center: [result.lon, result.lat] as [number, number],
        zoom: result.type === "station" ? 16 : 15,
      };
      // A search is a fresh start. Picking a station resets the story through
      // setSelected; an address mid-story has to drop the old pick itself,
      // or its trips and sheds would stay up under the new marker. Landing on
      // the intro paints its frame (a camera jump), so the fly waits for it.
      if (result.type !== "station" && useApp.getState().selected) {
        useApp.getState().setSelected(null);
        docksRef.current?.reset();
        pendingFlyRef.current = fly;
      } else {
        mapRef.current?.flyTo({ ...fly, duration: 800 });
      }

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
    shedsRef.current?.setData(null);
    // Also on a far-step switch: drop the old origin's lines rather than leave
    // them up while the new routes load.
    tripsRef.current?.clear();
  }, [selected]);

  // Landing on a step paints its static resting frame. Draw-out animations are
  // triggered separately by the UI's play buttons (story.playNear/playFar).
  useEffect(() => {
    const story = storyRef.current;
    if (!story) return;
    switch (phase) {
      case "intro": {
        story.showIntro();
        const fly = pendingFlyRef.current;
        if (fly) {
          pendingFlyRef.current = null;
          mapRef.current?.flyTo({ ...fly, duration: 800 });
        }
        break;
      }
      case "selected":
        story.showOrigin();
        break;
      case "near":
      case "reflect":
      case "subsidy":
      case "capped": // the near draw-out stays up until the far one plays
        story.holdNear();
        break;
      case "far":
        story.holdFar(layers, exploring);
        break;
      case "compare":
      case "final":
        story.holdFar();
        break;
    }
  }, [phase, layers, exploring]);

  // Routes for the pick arrived → hand them to the trip lines so they're ready
  // to draw when the UI triggers a step. A station with no routes file (data
  // null) simply has nothing to animate.
  useEffect(() => {
    if (!selected || !routesQuery.isSuccess) return;
    const routes = routesQuery.data;
    if (!routes) return;
    tripsRef.current?.show(routes);
    // show() resets the tiers to hidden. Normally the next step paints them, but
    // a far-step switch stays put — so repaint its resting frame now.
    const { phase, layers, exploring } = useApp.getState();
    if (phase === "far") storyRef.current?.holdFar(layers, exploring);
  }, [selected, routesQuery.isSuccess, routesQuery.data]);

  // Walkshed for the pick arrived → load it; the story decides when it shows.
  useEffect(() => {
    if (!selected || !walkshedQuery.isSuccess) return;
    shedsRef.current?.setData(walkshedQuery.data);

    // A far-step switch (a fresh pick flies in via selectStation instead):
    // frame the new origin's shown walksheds, padded clear of the top-left card
    // and the bottom control bar.
    const { phase, layers } = useApp.getState();
    const data = walkshedQuery.data;
    if (phase !== "far" || !data) return;
    const tiers = [layers.near && 11, layers.far && 45].filter(Boolean) as (
      | 11
      | 45
    )[];
    const bounds = walkshedBounds(data, tiers);
    if (!bounds) return;
    mapRef.current?.fitBounds(bounds, {
      padding: { top: 90, bottom: 120, left: 40, right: 40 },
      duration: 1200,
    });
  }, [selected, walkshedQuery.isSuccess, walkshedQuery.data]);

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
  // The card has content on the two draw-out steps only (see StepLegend).
  const showCard = phase === "near" || phase === "far";

  return (
    <>
      {/* Full-screen map behind everything. */}
      <div className="fixed inset-0">
        <div className="h-full w-full">
          <MaplibreMap
            ref={mapRef}
            // Dots and pins are both pickable: the intro's city view and the
            // far-step camera while exploring both sit below the pin gate, so
            // the dots are the only target there. Mid-story handleClick ignores
            // picks anyway, and StationBubble gates the hover label on the field.
            interactiveLayerIds={[
              DOCKS_HIT_LAYER,
              DOCKS_LAYER,
              DOCKS_ICON_LAYER,
            ]}
            mapStyle={STYLE_URL}
            initialViewState={{
              latitude: FULL_VIEW.center[1],
              longitude: FULL_VIEW.center[0],
              zoom: FULL_VIEW.zoom,
            }}
            padding={{ top: 0, bottom: 0, left: 0, right: 0 }}
            transformRequest={transformRequest}
            onLoad={handleMapLoad}
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            dragRotate={false}
            touchPitch={false}
          >
            {/* Edge of the service area. First of ours, so the walksheds and
                trip lines (inserted under the docks on load) and the docks
                themselves all stack above it. */}
            <Source id="coverage" type="geojson" data={COVERAGE_URL}>
              <Layer
                id="coverage-outline"
                type="line"
                paint={{
                  "line-color": COVERAGE_LINE_COLOR,
                  "line-width": COVERAGE_LINE_WIDTH,
                  "line-dasharray": COVERAGE_LINE_DASH,
                }}
              />
            </Source>
            <Source
              id={DOCKS_SOURCE}
              type="geojson"
              data="/stations.geojson"
              promoteId="station_id"
              maxzoom={13}
              buffer={512}
            >
              {/* Hit target first so it renders beneath the visible dot. */}
              <Layer
                id={DOCKS_HIT_LAYER}
                type="circle"
                paint={stationHitPaint()}
              />
              <Layer id={DOCKS_LAYER} type="circle" paint={stationPaint(0)} />
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
        {/* Orientation labels, up in every phase (Landmarks.tsx). */}
        <Landmarks />
        {/* The dock's third look — DOM markers, zoom-gated (StationBubble.tsx). */}
        <StationBubbles stations={stations} />
      </div>

      <div className="fixed inset-0 pointer-events-none">
        <div className="m-4 ml-16 flex justify-center flex flex-col gap-3 md:w-md">
          {/* The intro is just the search bar — the pitch lives in IntroOverlay. */}
          {phase !== "intro" && <Narrator />}
          {/* The map key, only on the two steps that have one, titled with the
              picked station's name. */}
          <AnimatePresence>
            {showCard && (
              <motion.div
                key="card"
                initial={{ opacity: 0, y: -8 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  height: height > 0 ? height + 24 : "auto",
                }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                style={{ overflow: "hidden" }}
                className="pointer-events-auto w-fit max-w-full rounded-xl bg-white/85 px-4 py-3 shadow-lg backdrop-blur"
              >
                <div ref={ref} className="flex flex-col gap-1.5">
                  {/* Station name + clear, desktop only: on a phone the card
                      has no width to spare, and Back on the first step already
                      returns to the start. */}
                  {selected && (
                    <div className="hidden items-center justify-between gap-3 md:flex">
                      <h2
                        className="text-xs font-bold leading-tight"
                        style={{ color: BRAND_ORANGE }}
                      >
                        {selected.name}
                      </h2>
                      {/* Clear: drop the pick and go back to the start. */}
                      <button
                        type="button"
                        aria-label="Clear station and start over"
                        title="Clear station"
                        className="-mr-1 flex size-5 cursor-pointer items-center justify-center rounded-full text-gray-400 hover:bg-gray-200/70 hover:text-gray-700"
                        onClick={resetMap}
                      >
                        <X className="size-3.5" strokeWidth={2.5} />
                      </button>
                    </div>
                  )}
                  <StepLegend />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
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

      {/* Always-on way back to the intro screen, menu-button sized. The card
          column starts at ml-16 to clear it. */}
      {!splash && (
        <button
          aria-label="About this map"
          title="About this map"
          // 38px + a 2px ring = 42px, the search bar's height (py-2.5 + text-sm
          // line + 1px borders); inset 2px so the ring's outer edge lines up
          // with the bar's top at 16px.
          className="fixed left-[18px] top-[18px] z-20 size-[38px] cursor-pointer rounded-full bg-white shadow-lg ring-2 ring-white transition-transform hover:scale-110"
          onClick={() => setSplash(true)}
        >
          {/* TA mark: the arrow is a cut-out, so the white button shows through. */}
          <img src="/ta-logo-mark.svg" alt="" className="size-full" />
        </button>
      )}

      {/* Org mark, bottom-left (MapLibre's attribution owns bottom-right). */}
      <a
        href="https://www.transalt.org"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-3 left-3 hidden rounded-md bg-white/85 px-2 py-1.5 shadow-sm backdrop-blur md:block"
      >
        <img
          src="/ta_logo_RGB_REFRESH_transparent.webp"
          alt="Transportation Alternatives"
          className="h-6 w-auto"
        />
      </a>

      <AnimatePresence>
        {splash && (
          <IntroOverlay
            onDismiss={() => setSplash(false)}
            search={
              <SearchBar
                mapCenter={mapRef.current?.getCenter()}
                onSelect={(result) => {
                  handleSelect(result);
                  setSplash(false);
                }}
                onClear={() => {
                  markerRef.current?.remove();
                  markerRef.current = null;
                }}
              />
            }
          />
        )}
      </AnimatePresence>
    </>
  );
}

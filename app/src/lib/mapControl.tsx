import { useApp } from "./store";
import { useMapStore, useSetMapInteractive } from "./mapStore";
import type { StationPoint } from "./dockController";
import { FULL_VIEW, ORIGIN_EASE, ORIGIN_ZOOM } from "./constants";

// Ease the camera onto an origin at ORIGIN_ZOOM, taking longer the further it
// has to go. Distance is measured in screen space at the starting zoom (that's
// how far the view visibly slides) plus the zoom change. Returns the duration
// so callers can wait out the move.
export const easeToOrigin = (
  map: maplibregl.Map,
  center: [number, number],
): number => {
  const container = map.getContainer();
  const from = map.project(map.getCenter());
  const to = map.project(center);
  const viewports =
    Math.hypot(to.x - from.x, to.y - from.y) /
    Math.max(container.clientWidth, container.clientHeight, 1);
  const zoomSteps = Math.abs(ORIGIN_ZOOM - map.getZoom());
  const { baseMs, msPerViewport, msPerZoom, minMs, maxMs } = ORIGIN_EASE;
  const duration = Math.round(
    Math.min(
      maxMs,
      Math.max(minMs, baseMs + viewports * msPerViewport + zoomSteps * msPerZoom),
    ),
  );
  map.easeTo({ center, zoom: ORIGIN_ZOOM, duration });
  return duration;
};

// Takes a plain StationPoint rather than a map feature: a dock is picked from
// the layers (handlers.ts unpacks the feature) OR from its bubble, which is a
// DOM node with no feature behind it.
export const useSelectStation = () => {
  const { setSelected } = useApp();
  const setMapInteractive = useSetMapInteractive(); // ensure the map is interactive when a station is picked
  return (station: StationPoint) => {
    const { map, docks, setOriginEaseMs } = useMapStore.getState();
    // Start the camera before publishing the pick, so the Narrator's control
    // gate (keyed on the selection) reads this ease's duration.
    if (map) setOriginEaseMs(easeToOrigin(map, [station.lon, station.lat]));

    setSelected({ id: station.id, name: station.name });

    // Highlight the picked dock red and fade the rest of the field out.
    docks?.selectDock(station.id);
    setMapInteractive(false);
  };
};

export const useResetMap = () => {
  const { setSelected } = useApp();
  const setMapInteractive = useSetMapInteractive();

  return () => {
    setSelected(null);
    setMapInteractive(true);
    const { map, docks } = useMapStore.getState();
    if (!map) return;
    docks?.reset();
    map.easeTo({
      center: FULL_VIEW.center,
      zoom: FULL_VIEW.zoom,
      duration: 2000,
    });
  };
};

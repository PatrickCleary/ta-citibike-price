import type maplibregl from "maplibre-gl";
import { STATIONS_LAYER } from "./dockController";
import { useApp } from "./store";

// Wire up the station pick + hover-cursor handlers on the map, and keep them
// bound only while the story is in the `intro` phase. Stations are pickable
// from the intro; once a station is chosen the phase advances and the handlers
// detach, so clicks no longer hijack an in-progress story.
//
// Returns an unregister function that drops the store subscription and any
// currently-attached handlers — call it on teardown.
export function registerMapHandlers(
  map: maplibregl.Map,
  onSelect: (stationId: maplibregl.MapGeoJSONFeature) => void,
): () => void {
  let clickHandler: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  let enterHandler: (() => void) | null = null;
  let leaveHandler: (() => void) | null = null;

  const attach = () => {
    if (clickHandler) return; // already attached
    clickHandler = (e) => {
      const f = e.features?.[0];
      if (!f) return;
      onSelect(f);
    };
    enterHandler = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    leaveHandler = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", STATIONS_LAYER, clickHandler);
    map.on("mouseenter", STATIONS_LAYER, enterHandler);
    map.on("mouseleave", STATIONS_LAYER, leaveHandler);
  };

  const detach = () => {
    if (clickHandler) map.off("click", STATIONS_LAYER, clickHandler);
    if (enterHandler) map.off("mouseenter", STATIONS_LAYER, enterHandler);
    if (leaveHandler) map.off("mouseleave", STATIONS_LAYER, leaveHandler);
    map.getCanvas().style.cursor = "";
    clickHandler = null;
    enterHandler = null;
    leaveHandler = null;
  };

  if (useApp.getState().phase === "intro") attach();

  const unsub = useApp.subscribe((state, prev) => {
    if (state.phase === "intro" && prev.phase !== "intro") attach();
    if (state.phase !== "intro" && prev.phase === "intro") detach();
  });

  return () => {
    unsub();
    detach();
  };
}

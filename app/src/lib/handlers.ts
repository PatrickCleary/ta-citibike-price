import type maplibregl from "maplibre-gl";
import {
  DOCKS_ICON_LAYER,
  DOCKS_LAYER,
  type StationPoint,
} from "./dockController";
import { useApp, useHover } from "./store";

// Wire up the station pick + hover handlers on the map, and keep them bound
// only while the story is in the `intro` phase. Stations are pickable from the
// intro; once a station is chosen the phase advances and the handlers detach,
// so clicks no longer hijack an in-progress story — and hover stops tracking,
// which is what confines the hover bubble to the intro.
//
// Returns an unregister function that drops the store subscription and any
// currently-attached handlers — call it on teardown.
export function registerMapHandlers(
  map: maplibregl.Map,
  onSelect: (station: StationPoint) => void,
): () => void {
  let clickHandler: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  let moveHandler: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  let leaveHandler: (() => void) | null = null;

  const LAYERS = [DOCKS_LAYER, DOCKS_ICON_LAYER];

  const attach = () => {
    if (clickHandler) return; // already attached
    clickHandler = (e) => {
      const station = toStation(e.features?.[0]);
      if (station) onSelect(station);
    };
    // mousemove, not mouseenter: enter fires once for the LAYER, but the bubble
    // needs to follow the cursor from dock to dock within it.
    moveHandler = (e) => {
      map.getCanvas().style.cursor = "pointer";
      const id = e.features?.[0]?.properties?.station_id;
      useHover.getState().setHovered(typeof id === "string" ? id : null);
    };
    leaveHandler = () => {
      map.getCanvas().style.cursor = "";
      useHover.getState().setHovered(null);
    };

    for (const layer of LAYERS) {
      map.on("click", layer, clickHandler);
      map.on("mousemove", layer, moveHandler);
      map.on("mouseleave", layer, leaveHandler);
    }
  };

  const detach = () => {
    for (const layer of LAYERS) {
      if (clickHandler) map.off("click", layer, clickHandler);
      if (moveHandler) map.off("mousemove", layer, moveHandler);
      if (leaveHandler) map.off("mouseleave", layer, leaveHandler);
    }
    map.getCanvas().style.cursor = "";
    useHover.getState().setHovered(null);
    clickHandler = null;
    moveHandler = null;
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

function toStation(
  f: maplibregl.MapGeoJSONFeature | undefined,
): StationPoint | null {
  if (!f) return null;
  const id = f.properties?.station_id;
  const name = f.properties?.name;
  const coords =
    f.geometry?.type === "Point" ? f.geometry.coordinates : undefined;
  const [lon, lat] = coords ?? [];
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  return { id, name, lon, lat };
}

import { useApp } from "./store";
import { useMapStore, useSetMapInteractive } from "./mapStore";
import type { StationPoint } from "./dockController";
import { FULL_VIEW, ORIGIN_EASE_MS, ORIGIN_ZOOM } from "./constants";

// Takes a plain StationPoint rather than a map feature: a dock is picked from
// the layers (handlers.ts unpacks the feature) OR from its bubble, which is a
// DOM node with no feature behind it.
export const useSelectStation = () => {
  const { setSelected } = useApp();
  const setMapInteractive = useSetMapInteractive(); // ensure the map is interactive when a station is picked
  return (station: StationPoint) => {
    setSelected({ id: station.id, name: station.name });

    // Highlight the picked dock red and fade the rest of the field out.
    const { map, docks } = useMapStore.getState();
    docks?.selectDock(station.id);
    setMapInteractive(false);
    if (!map) return;
    map.easeTo({
      center: [station.lon, station.lat],
      zoom: ORIGIN_ZOOM,
      duration: ORIGIN_EASE_MS,
    }); // ease out
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

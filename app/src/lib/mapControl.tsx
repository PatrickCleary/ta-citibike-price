import { useApp } from "./store";
import { useMapStore, useSetMapInteractive } from "./mapStore";
import { FULL_VIEW, ORIGIN_EASE_MS, ORIGIN_ZOOM } from "./constants";

export const useSelectStation = () => {
  const { setSelected } = useApp();
  const setMapInteractive = useSetMapInteractive(); // ensure the map is interactive when a station is picked
  return (station: maplibregl.MapGeoJSONFeature) => {
    const stationId = station.properties?.station_id as string;
    const name = station.properties?.name as string;
    const lng = station.geometry?.coordinates?.[0] as number;
    const lat = station.geometry?.coordinates?.[1] as number;
    if (!stationId || !name || lng === undefined || lat === undefined) return;
    setSelected({ id: stationId, name: name }); // name is unused, so just blank it out

    // Highlight the picked dock red and fade the rest of the field out.
    const { map, docks } = useMapStore.getState();
    docks?.selectDock(stationId);
    console.log('disbling')
    setMapInteractive(false);
    if (!map) return;
    map.easeTo({
      center: [lng, lat],
      zoom: ORIGIN_ZOOM,
      duration: ORIGIN_EASE_MS,
    }); // ease out
  };
};

export const useResetMap = () => {
  const { setSelected } = useApp();

  return () => {
    setSelected(null);
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

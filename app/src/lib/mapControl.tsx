import { useApp } from "./store";
import { useMapStore } from "./mapStore";
import { FULL_VIEW } from "./constants";

export const useSelectStation = () => {
  const { setSelected } = useApp();
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

    if (!map) return;
    map.easeTo({ center: [lng, lat], zoom: 16, duration: 2000 }); // ease out
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

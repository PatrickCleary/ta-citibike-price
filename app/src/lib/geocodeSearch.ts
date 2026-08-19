import { GeocodingApi } from "@stadiamaps/api";

export type Suggestion =
  | {
      type: "station";
      id?: string;
      label?: string;
      stationName?: string;
      lat?: number;
      lon?: number;
    }
  | {
      type: "address";
      id?: string;
      label?: string;
      lat?: number;
      lon?: number;
    };

const api = new GeocodingApi();

export async function searchAddresses(
  query: string,
  focusPoint?: maplibregl.LngLat,
): Promise<Array<Suggestion>> {
  const res = await api.autocomplete({
    text: query,
    boundaryRectMinLon: -74.05,
    boundaryRectMinLat: 40.55,
    boundaryRectMaxLon: -73.7,
    boundaryRectMaxLat: 40.92,
    layers: ["address", "street", "venue", "postalcode"],
    focusPointLat: focusPoint?.lat,
    focusPointLon: focusPoint?.lng,
  });

  return res.features.map((f) => {
    const isStation = f.properties?.name?.toLowerCase().startsWith("citi bike");
    return {
      type: isStation ? ("station" as const) : ("address" as const),
      id: f.properties?.gid,
      label: f.properties?.label,
      ...(isStation
        ? { stationName: f.properties?.name?.replace("Citi Bike - ", "") }
        : {}),
      lat: f.geometry?.coordinates[1],
      lon: f.geometry?.coordinates[0],
    };
  });
}

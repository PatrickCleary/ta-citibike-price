import type maplibregl from "maplibre-gl";
import { type StationPoint } from "./dockController";

export function toStation(
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

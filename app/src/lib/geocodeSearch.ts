export interface GeocodeResult {
  id: string;
  label: string;
  lat: number;
  lon: number;
}

const STADIA_API_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;

export async function searchAddresses(
  query: string,
  focusPoint?: maplibregl.LngLat, // bias results near map center
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    text: query,
    api_key: STADIA_API_KEY,
    // NYC bounding box
    'boundary.rect.min_lon': '-74.05',
    'boundary.rect.min_lat': '40.55',
    'boundary.rect.max_lon': '-73.7',
    'boundary.rect.max_lat': '40.92',
    layers: ['address', 'street', 'venue', 'neighbourhood', 'postalcode'].join(','), 
  });

  if (focusPoint) {
    params.set('focus.point.lat', String(focusPoint.lat));
    params.set('focus.point.lon', String(focusPoint.lng));
  }

  const res = await fetch(
    `https://api.stadiamaps.com/geocoding/v1/autocomplete?${params}`,
    { signal }
  );
  const data = await res.json();

  return data.features.map((f: any) => ({
    id: f.properties.gid,
    label: f.properties.label,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  }));
}
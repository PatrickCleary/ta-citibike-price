# Citi Bike Sheds — web app

Static map of Citi Bike stations. Click a station to see its bike sheds — the
area reachable within 11 and 45 minutes of riding.

**Stack:** Astro (static) · MapLibre GL JS · Stadia basemap · React island ·
Tailwind v4 · Vercel Analytics. Data is GeoJSON throughout — no tiles server.

## Data flow

Source of truth lives at the repo root and is produced by `compute_bikesheds.py`:

- `stations.json` — GBFS station list
- `output/<station_id>.geojson` — one file per station, each a FeatureCollection
  with a polygon per contour (`contour: 11`, `contour: 45`)

`npm run build:data` (run automatically by `npm run build`) derives the app's
station data into `public/stations.geojson` (gitignored, regenerated on demand)
— slimmed to `station_id`, `name`, `capacity`. Stations load once as a single
source.

Sheds are **not** bundled with the app. They're fetched lazily on station click
from `PUBLIC_SHEDS_BASE_URL`, which defaults to the public Supabase bucket. When
the pipeline regenerates `output/`, upload those files to the bucket's
`bikesheds/` path separately.

## Develop

```bash
npm install
npm run build:data   # regenerate stations.geojson + sheds from ../output
npm run dev          # http://localhost:4321
```

Copy `.env.example` to `.env` and set `PUBLIC_STADIA_API_KEY` (free at
stadiamaps.com). Keyless requests work from localhost during development.

## Deploy (Vercel)

Set the Vercel project Root Directory to `app`. The build (`npm run build`) only
generates `stations.geojson` from `../stations.json`, so the deployment stays
small — sheds are served at runtime from Supabase. Set `PUBLIC_STADIA_API_KEY`
(and optionally `PUBLIC_SHEDS_BASE_URL`) as environment variables.

## Notes

- Contours are configured in `src/lib/sheds.ts` (`CONTOURS`). If the pipeline
  changes which time bands it emits, update that array — colors and the toggle
  derive from it.
- The basemap style is Stadia "Alidade Smooth"; swap in `src/components/Map.tsx`.

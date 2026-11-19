# Citi Bike Sheds — web app

Static map of Citi Bike stations. Click a station to see its bike sheds — the
area reachable within 11 and 45 minutes of riding.

**Stack:** Astro (static) · MapLibre GL JS · Stadia basemap · React island ·
Tailwind v4. Data is GeoJSON throughout — no tiles server.

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

## Deploy (Netlify)

The site is fully static. `netlify.toml` at the repo root sets the base
directory to `app`, runs `npm run build`, and publishes `app/dist`. Hooking the
repo up to Netlify (Add new site > Import an existing project) is all that's
needed; every push to `main` rebuilds and deploys.

Set `PUBLIC_STADIA_API_KEY` under Site configuration > Environment variables
before the first build; it is baked into the bundle at build time. Then add the
Netlify domain (and any custom domain) to the key's allowed referrers in the
Stadia dashboard, or the basemap tiles will 403.

The build only generates `stations.geojson` from `../stations.json`, so the
deploy stays small (about 3 MB). Per-station routes, reach lists and walksheds
are fetched at runtime from the public Supabase bucket; see `src/lib/*.ts` for
the `PUBLIC_*_BASE_URL` overrides.

To deploy by hand instead, run `npm run build` locally and drag `app/dist` onto
https://app.netlify.com/drop.

## Notes

- Contours are configured in `src/lib/sheds.ts` (`CONTOURS`). If the pipeline
  changes which time bands it emits, update that array — colors and the toggle
  derive from it.
- The basemap style is Stadia "Alidade Smooth"; swap in `src/components/Map.tsx`.

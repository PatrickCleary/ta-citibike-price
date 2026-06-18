// Generates the web app's station data from the pipeline outputs.
//
//  - stations.json  ->  public/stations.geojson  (slimmed: id, name, capacity)
//
// Source of truth (stations.json) lives at the repo root; the generated
// stations.geojson under public/ is gitignored. Re-run when the station list
// changes:  npm run build:data
//
// Sheds are NOT bundled — the app fetches them at runtime from the Supabase
// bucket referenced by PUBLIC_SHEDS_BASE_URL (see src/lib/sheds.ts). Upload
// output/*.geojson to that bucket separately when sheds are regenerated.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");      // app/scripts -> repo root
const publicDir = resolve(__dirname, "../public");

const STATIONS_SRC = join(repoRoot, "stations.json");
const STATIONS_OUT = join(publicDir, "stations.geojson");

async function buildStations() {
  const raw = JSON.parse(await readFile(STATIONS_SRC, "utf8"));
  const stations = raw?.data?.stations ?? [];
  const features = [];
  for (const s of stations) {
    if (typeof s.lon !== "number" || typeof s.lat !== "number") continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        station_id: s.station_id,
        name: s.name,
        capacity: s.capacity ?? null,
      },
    });
  }
  const fc = { type: "FeatureCollection", features };
  await writeFile(STATIONS_OUT, JSON.stringify(fc));
  return features.length;
}

await mkdir(publicDir, { recursive: true });
const stationCount = await buildStations();
console.log(`✓ stations.geojson: ${stationCount} stations`);

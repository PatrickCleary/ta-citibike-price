// Generates the web app's station data from the pipeline outputs.
//
//  - stations.json  ->  public/stations.geojson  (slimmed: id, name, capacity)
//
// Source of truth (stations.json) lives at the repo root; the generated
// stations.geojson under public/ is gitignored. Re-run when the station list
// changes:  npm run build:data
//
// Reachability lists are NOT bundled — the app fetches them at runtime from the
// Supabase bucket referenced by PUBLIC_REACH_BASE_URL (see src/lib/sheds.ts).
// Upload reachable/*.json to that bucket separately when they're regenerated.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");      // app/scripts -> repo root
const publicDir = resolve(__dirname, "../public");

const STATIONS_SRC = join(repoRoot, "stations.json");
const STATIONS_OUT = join(publicDir, "stations.geojson");

// Stations left off the map. Governors Island: Valhalla's 45-min bikeshed drops
// the island itself (denoise), so its reach lists and walksheds come out wrong,
// and its routes files are empty.
const HIDDEN_STATIONS = new Set([
  "35915f48-31c5-499a-b845-2ca2fb541904", // Yankee Ferry Terminal
  "2088792249063596144", // Soissons Landing
  "324af152-33ea-48a7-8bb0-ad8b6f31571f", // Picnic Point
]);

async function buildStations() {
  const raw = JSON.parse(await readFile(STATIONS_SRC, "utf8"));
  const stations = raw?.data?.stations ?? [];
  const features = [];
  for (const s of stations) {
    if (typeof s.lon !== "number" || typeof s.lat !== "number") continue;
    if (HIDDEN_STATIONS.has(s.station_id)) continue;
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

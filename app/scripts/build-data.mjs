// Generates the web app's station data from the pipeline outputs.
//
//  - stations.json  ->  public/stations.geojson  (slimmed: id, name, capacity,
//                       borough) and the same as src/data/stations.json
//                       (imported by the page)
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
// The same collection, imported by src/pages/index.astro for the first render.
const STATIONS_SRC_COPY = resolve(__dirname, "../src/data/stations.json");

// Stations left off the map. Governors Island: Valhalla's 45-min bikeshed drops
// the island itself (denoise), so its reach lists and walksheds come out wrong,
// and its routes files are empty.
const HIDDEN_STATIONS = new Set([
  "35915f48-31c5-499a-b845-2ca2fb541904", // Yankee Ferry Terminal
  "2088792249063596144", // Soissons Landing
  "324af152-33ea-48a7-8bb0-ad8b6f31571f", // Picnic Point
]);

// Jersey City and Hoboken are part of the system but not of this map's story,
// so their docks are left off entirely. West of the Hudson and north of Bay
// Ridge (whose Shore Rd docks also sit west of the line) is New Jersey. Same
// rule as scripts/build-coverage.mjs.
const inNewJersey = (lon, lat) => lon < -74.021 && lat > 40.68;

// Each dock's borough, for the story's "From <dock> in <borough>" line. Point in
// polygon against NYC's borough boundaries, the water-areas-included version
// (NYC Open Data wh2p-dxnf), so docks on piers and the waterline still land
// inside one. Anything that somehow falls outside every polygon takes the
// nearest borough.
const BOROUGHS = JSON.parse(
  await readFile(join(__dirname, "data/boroughs.geojson"), "utf8"),
).features;

const inRing = (lon, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
};
// Holes (rings after the first) carve out of their polygon.
const inMultiPolygon = (lon, lat, polys) =>
  polys.some(
    ([outer, ...holes]) =>
      inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)),
  );
// Squared distance to the nearest vertex: rough, but only a fallback.
const vertexDist2 = (lon, lat, polys) =>
  Math.min(
    ...polys.flat(2).map(([x, y]) => (x - lon) ** 2 + (y - lat) ** 2),
  );

let boroughFallbacks = 0;
function boroughOf(lon, lat) {
  const hit = BOROUGHS.find((b) =>
    inMultiPolygon(lon, lat, b.geometry.coordinates),
  );
  if (hit) return hit.properties.name;
  boroughFallbacks++;
  let best = null;
  for (const b of BOROUGHS) {
    const d = vertexDist2(lon, lat, b.geometry.coordinates);
    if (!best || d < best.d) best = { d, name: b.properties.name };
  }
  return best.name;
}

async function buildStations() {
  const raw = JSON.parse(await readFile(STATIONS_SRC, "utf8"));
  const stations = raw?.data?.stations ?? [];
  const features = [];
  let nj = 0;
  for (const s of stations) {
    if (typeof s.lon !== "number" || typeof s.lat !== "number") continue;
    if (HIDDEN_STATIONS.has(s.station_id)) continue;
    if (inNewJersey(s.lon, s.lat)) {
      nj++;
      continue;
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        station_id: s.station_id,
        name: s.name,
        capacity: s.capacity ?? null,
        borough: boroughOf(s.lon, s.lat),
      },
    });
  }
  const fc = { type: "FeatureCollection", features };
  await writeFile(STATIONS_OUT, JSON.stringify(fc));
  await writeFile(STATIONS_SRC_COPY, JSON.stringify(fc));
  return { count: features.length, nj };
}

await mkdir(publicDir, { recursive: true });
const { count, nj } = await buildStations();
console.log(`✓ stations.geojson + src/data/stations.json: ${count} stations (${nj} in New Jersey left off)`);
if (boroughFallbacks)
  console.log(`  ${boroughFallbacks} outside every borough polygon, given the nearest`);

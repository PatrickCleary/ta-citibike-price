// Which landmarks can ANY Citi Bike trip reach — i.e. which have any part (pin
// or footprint, see build-landmark-areas.mjs) inside at least one station's
// 5-minute walkshed. The story's "but not X" sentence (landmarkReach.ts) should
// never name a place that no ride could reach anyway.
//
//   node scripts/build-landmark-reach.mjs      (or: npm run build:landmark-reach)
//
// There's no local copy of the per-station walk polygons, but every origin's
// published ≤45-minute shed (walkshed_unions) is the union of ~1000 of them. So:
// pick origins by farthest-point sampling until their 45-sheds between them
// contain every station, fetch those few files, and test each landmark against
// the lot. Writes src/data/landmarkReachability.json: { [id]: boolean }.
// Re-run when landmarks or stations change.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const STATIONS = join(root, "public", "stations.geojson");
const LANDMARKS_TS = join(root, "src", "data", "landmarks.ts");
const AREAS = join(root, "src", "data", "landmarkAreas.json"); // build-landmark-areas.mjs first
const OUT = join(root, "src", "data", "landmarkReachability.json");
const BASE =
  process.env.PUBLIC_WALKSHED_BASE_URL?.replace(/\/$/, "") ||
  "https://kevndteqglsoslznrntz.supabase.co/storage/v1/object/public/ta-citibike-price/walkshed_unions";
const MAX_ORIGINS = 40;

// --- geometry ---------------------------------------------------------------
const inRing = ([x, y], ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (p, rings) =>
  rings.length > 0 && inRing(p, rings[0]) && !rings.slice(1).some((r) => inRing(p, r));
const inGeometry = (p, g) =>
  g.type === "Polygon" ? inPolygon(p, g.coordinates) : g.coordinates.some((r) => inPolygon(p, r));
const meters = (a, b) => {
  const c = Math.cos((a[1] * Math.PI) / 180);
  return 111320 * Math.hypot((b[0] - a[0]) * c, b[1] - a[1]);
};

// --- inputs -----------------------------------------------------------------
const stations = JSON.parse(await readFile(STATIONS, "utf8")).features.map((f) => ({
  id: f.properties.station_id,
  name: f.properties.name,
  p: f.geometry.coordinates,
}));
const landmarks = [...(await readFile(LANDMARKS_TS, "utf8")).matchAll(
  /id: "([^"]+)", name: "([^"]+)", emoji: "[^"]*", borough: "[^"]+", tier: \d, lon: ([-\d.]+), lat: ([-\d.]+)/g,
)].map((m) => ({ id: m[1], name: m[2], p: [Number(m[3]), Number(m[4])] }));

// --- fetch 45-sheds from farthest-point-sampled origins until every station is covered
const sheds = []; // geometries (tier 45)
const covered = new Set();
const fetchShed = async (s) => {
  const res = await fetch(`${BASE}/${s.id}.geojson`);
  if (!res.ok) return null;
  const fc = await res.json();
  return fc.features.filter((f) => f.properties.tier === 45).map((f) => f.geometry);
};
const coverPass = () => {
  for (const s of stations) if (!covered.has(s.id) && sheds.some((g) => inGeometry(s.p, g))) covered.add(s.id);
};
// Start from the station nearest the centroid; thereafter the uncovered station
// farthest from every origin so far.
const centroid = stations.reduce((a, s) => [a[0] + s.p[0] / stations.length, a[1] + s.p[1] / stations.length], [0, 0]);
let next = stations.reduce((b, s) => (meters(centroid, s.p) < meters(centroid, b.p) ? s : b));
const origins = [];
while (next && origins.length < MAX_ORIGINS) {
  const g = await fetchShed(next);
  origins.push(next);
  if (g) { sheds.push(...g); coverPass(); }
  else covered.add(next.id); // no shed published: nothing to learn from it; skip
  const uncovered = stations.filter((s) => !covered.has(s.id));
  if (!uncovered.length) break;
  next = uncovered.reduce((b, s) => {
    const d = Math.min(...origins.map((o) => meters(o.p, s.p)));
    const db = Math.min(...origins.map((o) => meters(o.p, b.p)));
    return d > db ? s : b;
  });
  process.stdout.write(`\r${origins.length} origins, ${covered.size}/${stations.length} stations covered   `);
}
console.log(`\n${origins.length} origins fetched; ${covered.size}/${stations.length} stations inside some 45-shed`);
const missed = stations.filter((s) => !covered.has(s.id));
if (missed.length) console.log("uncovered stations:", missed.map((s) => s.name).join("; "));

// --- test landmarks: the pin, or any point of the footprint -------------------
const areas = JSON.parse(await readFile(AREAS, "utf8"));
const reach = {};
for (const l of landmarks) {
  const pts = [l.p, ...(areas[l.id] ?? [])];
  reach[l.id] = pts.some((p) => sheds.some((g) => inGeometry(p, g)));
}
await writeFile(OUT, JSON.stringify(reach, null, 2) + "\n");
const out = landmarks.filter((l) => !reach[l.id]).map((l) => l.name);
console.log(`${landmarks.length - out.length} landmarks reachable, ${out.length} never: ${out.join("; ")}`);
console.log(`→ ${OUT}`);

// Footprints for the landmarks, so "can you get to X" asks about any part of X,
// not just its pin — the pin sits in the middle of a park, but a ride that
// reaches the park's edge has reached the park.
//
//   node scripts/build-landmark-areas.mjs      (or: npm run build:landmark-areas)
//
// Looks each landmark up on Nominatim (OpenStreetMap) with its polygon, keeps
// the result whose footprint contains the pin (else the nearest within
// NEAR_M), and samples that footprint's boundary every SAMPLE_M metres. A
// landmark that resolves to a point keeps only its pin. Writes
// src/data/landmarkAreas.json: { [id]: [[lon, lat], ...] } (boundary samples).
// Nominatim allows one request a second, so this takes ~1.5 minutes. Re-run
// when landmarks are added or moved.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const LANDMARKS_TS = join(root, "src", "data", "landmarks.ts");
const OUT = join(root, "src", "data", "landmarkAreas.json");

const NEAR_M = 400; // a footprint that doesn't contain the pin must come this close
const SAMPLE_M = 80; // boundary sample spacing (walkshed fingers are ≥300 m wide)
const MAX_SAMPLES = 120;
// Rough NYC box so "Union Square" doesn't resolve to San Francisco.
const VIEWBOX = "-74.3,40.45,-73.65,40.95";

const meters = (a, b) => {
  const c = Math.cos((a[1] * Math.PI) / 180);
  return 111320 * Math.hypot((b[0] - a[0]) * c, b[1] - a[1]);
};
const inRing = ([x, y], ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// Every boundary line of a geometry (outer rings and holes; lines as-is).
function lines(g) {
  switch (g.type) {
    case "Polygon": return g.coordinates;
    case "MultiPolygon": return g.coordinates.flat();
    case "LineString": return [g.coordinates];
    case "MultiLineString": return g.coordinates;
    default: return [];
  }
}
const contains = (g, p) =>
  g.type === "Polygon" ? inRing(p, g.coordinates[0]) :
  g.type === "MultiPolygon" ? g.coordinates.some((rings) => inRing(p, rings[0])) : false;
const nearest = (g, p) => Math.min(...lines(g).flat().map((q) => meters(q, p)));

// Points every SAMPLE_M along each line, vertices included.
function sample(g) {
  const out = [];
  for (const line of lines(g)) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const n = Math.max(1, Math.ceil(meters(a, b) / SAMPLE_M));
      for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    out.push(line[line.length - 1]);
  }
  if (out.length <= MAX_SAMPLES) return out;
  const step = out.length / MAX_SAMPLES;
  return Array.from({ length: MAX_SAMPLES }, (_, i) => out[Math.floor(i * step)]);
}

const landmarks = [...(await readFile(LANDMARKS_TS, "utf8")).matchAll(
  /id: "([^"]+)", name: "([^"]+)", emoji: "[^"]*", borough: "([^"]+)", tier: \d, lon: ([-\d.]+), lat: ([-\d.]+)/g,
)].map((m) => ({ id: m[1], name: m[2], borough: m[3], p: [Number(m[4]), Number(m[5])] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const areas = {};
let existing = {};
try { existing = JSON.parse(await readFile(OUT, "utf8")); } catch {}

for (const l of landmarks) {
  const q = `${l.name}, ${l.borough === "New Jersey" ? "NJ" : "New York City"}`;
  const url = `https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&limit=5&bounded=1&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`;
  let fc = null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "citibike-sheds-landmarks (one-off data build)" } });
    if (res.ok) fc = await res.json();
  } catch {}
  await sleep(1100);
  const shapes = (fc?.features ?? []).filter((f) => f.geometry && f.geometry.type !== "Point");
  const hit = shapes.find((f) => contains(f.geometry, l.p)) ??
    shapes.filter((f) => nearest(f.geometry, l.p) <= NEAR_M).sort((a, b) => nearest(a.geometry, l.p) - nearest(b.geometry, l.p))[0];
  if (hit) {
    areas[l.id] = sample(hit.geometry).map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
    console.log(`${l.name}: ${hit.geometry.type}, ${areas[l.id].length} samples  (${hit.properties.display_name.split(",")[0]})`);
  } else {
    console.log(`${l.name}: pin only${shapes.length ? ` (${shapes.length} shapes, none near)` : ""}`);
  }
}
await writeFile(OUT, JSON.stringify(areas) + "\n"); // ~60 KB
console.log(`\n${Object.keys(areas).length}/${landmarks.length} landmarks with footprints → ${OUT}`);

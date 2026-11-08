// Builds the Citi Bike service-area polygon, drawn as an outline on the map
// (Map.tsx, COVERAGE_* constants).
//
//   node scripts/build-coverage.mjs        (or: npm run build:coverage)
//
// The service area is derived from the NYC stations themselves (NJ excluded): a concave hull
// around every dock (edges longer than MAX_EDGE_KM are left open, so the river
// gaps and the outer boroughs' ragged edge survive), padded by PAD_KM so the
// edge sits a short walk past the outermost docks, then simplified. Output is
// committed (public/data/coverage.geojson); re-run when the station list
// changes.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as turf from "@turf/turf";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public");
const STATIONS = join(publicDir, "stations.geojson");
const OUT = join(publicDir, "data", "coverage.geojson");

const MAX_EDGE_KM = 1.4; // hull edges longer than this are carved out
const PAD_KM = 0.5; // breathing room past the outermost docks
const SIMPLIFY_DEG = 0.0004; // ~40 m

// Jersey City and Hoboken are part of the system but not of this map's story,
// so their docks are left out of the outline. West of the Hudson and north of
// Bay Ridge (whose Shore Rd docks also sit west of the line) is New Jersey.
// -74.021 splits Hoboken's north waterfront (-74.024) from Battery Park City
// (-74.017).
const inNewJersey = ([lon, lat]) => lon < -74.021 && lat > 40.68;

const stations = JSON.parse(await readFile(STATIONS, "utf8"));
const points = turf.featureCollection(
  stations.features
    .map((f) => f.geometry.coordinates)
    .filter((c) => !inNewJersey(c))
    .map((c) => turf.point(c)),
);

const hull = turf.concave(points, { maxEdge: MAX_EDGE_KM, units: "kilometers" });
if (!hull) throw new Error("concave hull failed — raise MAX_EDGE_KM");
const padded = turf.buffer(hull, PAD_KM, { units: "kilometers" });
const coverage = turf.simplify(padded, { tolerance: SIMPLIFY_DEG, highQuality: true });

coverage.properties = { kind: "citibike-service-area" };

const area = turf.area(coverage) / 1e6;
const verts = JSON.stringify(coverage.geometry.coordinates).match(/\[-?\d/g).length;
await writeFile(OUT, JSON.stringify(coverage));
console.log(
  `coverage ${area.toFixed(0)} km², ${coverage.geometry.type}, ${verts} vertices → ${OUT}`,
);

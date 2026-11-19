import { withBase } from "./base";
// The brand orange. Worn by the dock dots and the station bubbles — they're
// both the same "this is a dock" signal, so they share a hex.
export const BRAND_ORANGE = "#F5532B";

// Full-metro view shown before a station is picked.
export const FULL_VIEW = {
  center: [-73.95, 40.71] as [number, number],
  zoom: 10.3,
};

// Zoom the camera settles at on the picked origin — where the selection ease
// lands, and where a replay rewinds to before drawing a step out again.
export const ORIGIN_ZOOM = 16;

// Where a fresh pick's dock lands, as a fraction of the screen height below
// centre: low enough to clear PickedHeader's question and Play button above it.
// (A replay's rewind has no header to clear, so it centres the dock.)
export const PICK_OFFSET = 0.2;

// Timing of the ease onto a picked origin (the selection, and a replay's rewind).
// The duration scales with how far the camera has to travel, a roughly constant
// speed with easing on top, so a hop to the next dock over is quick and the
// long dive in from the metro view takes its time. See easeToOrigin.
export const ORIGIN_EASE = {
  baseMs: 300, // floor cost of any move, so even a tiny hop still eases
  msPerViewport: 600, // per screen-width of pan, measured at the starting zoom
  msPerZoom: 250, // per zoom level gained or lost
  minMs: 400,
  maxMs: 2000,
};

// Outline of Citi Bike's service area (public/data/coverage.geojson, built by
// scripts/build-coverage.mjs): a quiet dashed edge, so the basemap outside it
// stays readable but it's clear where the system stops.
export const COVERAGE_URL = withBase("/data/coverage.geojson");
export const COVERAGE_LINE_COLOR = "#8a8a8a";
export const COVERAGE_LINE_WIDTH = 1.25;
export const COVERAGE_LINE_DASH = [3, 2];

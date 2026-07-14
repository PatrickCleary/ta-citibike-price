// The brand orange. Worn by the dock dots, the region halo, and the station
// bubbles — they're all the same "this is a dock" signal, so they share a hex.
export const BRAND_ORANGE = "#F5532B";

// Full-metro view shown before a station is picked.
export const FULL_VIEW = {
  center: [-73.95, 40.71] as [number, number],
  zoom: 10.3,
};

// Zoom the camera settles at on the picked origin — where the selection ease
// lands, and where a replay rewinds to before drawing a step out again.
export const ORIGIN_ZOOM = 16;

// Duration of both the selection ease-in and a replay's rewind to the origin.
export const ORIGIN_EASE_MS = 2000;

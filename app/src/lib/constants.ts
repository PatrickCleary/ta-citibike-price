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

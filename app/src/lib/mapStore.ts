// Holds the live, imperative map objects so any component can reach them
// without prop-drilling a ref. These are mutable singletons owned by the Map
// component, published here on creation and cleared on teardown. Reading them
// is non-reactive by design (a map instance never "changes" — it's created
// once), so consumers grab them via getState() inside callbacks rather than
// subscribing.

import { create } from "zustand";
import type { DockController } from "./dockController";
import type { StoryController } from "./storyController";

interface MapStore {
  map: maplibregl.Map | null;
  docks: DockController | null;
  story: StoryController | null;

  setMap: (map: maplibregl.Map | null) => void;
  setDocks: (docks: DockController | null) => void;
  setStory: (story: StoryController | null) => void;
}

export const useMapStore = create<MapStore>((set) => ({
  map: null,
  docks: null,
  story: null,

  setMap: (map) => set({ map }),
  setDocks: (docks) => set({ docks }),
  setStory: (story) => set({ story }),
}));
const handlers = [
  "scrollZoom",
  "boxZoom",
  "dragPan",
  "dragRotate",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
];
export const useSetMapInteractive = () => {
  return (interactive: boolean) => {
    // Read at call time, not render time: this callback is captured once into
    // the map click handler, before the map instance is published.
    const { map } = useMapStore.getState();
    if (!map) return;

    if (interactive) {
      // To enable all
      handlers.forEach((handler) => map[handler].enable());
      return;
    }
    // To disable all
    handlers.forEach((handler) => map[handler].disable());
  };
};

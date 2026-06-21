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

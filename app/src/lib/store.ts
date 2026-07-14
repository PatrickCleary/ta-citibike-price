// App state machine (zustand).
//
// This holds the DISCRETE control state of the story — which station is picked
// and which narrated step we're on — and nothing else. Server data (reach /
// routes) lives in react-query (see queries.ts); the imperative map, wave, and
// trip-line animations live in the Map component. The buttons drive the story
// purely by stepping this machine; the component reacts and plays each timed
// transition.

import { create } from "zustand";

export interface Dock {
  id: string;
  name: string;
}

// The story is four discrete, independently re-enterable steps (plus `intro`,
// the pre-selection state). Each step owns a static resting frame; the two
// draw-out steps (`near`, `far`) also have an animation the UI's play button
// triggers. There is no scrubbing — you only ever play a step forward or land
// on its resting frame (e.g. via reset-to-any-step).
export type Phase = "intro" | "selected" | "near" | "far" | "final";

// The animated draw-out steps (the ones with a bike-speed tween).
export type StepKey = "near" | "far";

// Constant-bike-speed playback: a draw-out step animates at this multiple of
// real ride time (e.g. 140× → a 45-min route draws out in ~19s of wall clock).
export const PLAYBACK_SPEEDUP = 140;

// The navigable steps prev/next move between, in order. `intro` sits before
// this sequence (entered by clearing the selection).
export const STEP_ORDER = [
  "selected",
  "near",
  "far",
  "final",
] as const satisfies readonly Phase[];

interface AppState {
  /** Picked station, or null in the intro. */
  selected: Dock | null;
  /** Pick (or clear) a station; picking enters the story at the first step. */
  setSelected: (s: Dock | null) => void;
  /** Current story step; `intro` while picking in the intro. */
  phase: Phase;
  /** Jump directly to any step (the reset-to-any-step controls use this). */
  setPhase: (p: Phase) => void;
  /** Step forward through STEP_ORDER (no-op at the last step). */
  advance: () => void;
  /** Step back through STEP_ORDER; from the first step, return to the intro. */
  back: () => void;
}

// Transient pointer state, deliberately NOT part of AppState: hovering isn't a
// step of the story and must never be confused with a pick. Lives here rather
// than in mapStore because it IS reactive — the bubble layer re-renders on it.
interface HoverState {
  /** Dock under the cursor, or null. Only tracked during the intro. */
  hoveredId: string | null;
  setHovered: (id: string | null) => void;
}

export const useHover = create<HoverState>((set) => ({
  hoveredId: null,
  setHovered: (hoveredId) => set({ hoveredId }),
}));

export const useApp = create<AppState>((set) => ({
  selected: null,
  setSelected: (s) => set({ selected: s, phase: s ? STEP_ORDER[0] : "intro" }),
  phase: "intro",
  setPhase: (p) => set({ phase: p }),
  advance: () =>
    set((s) => {
      const i = (STEP_ORDER as readonly Phase[]).indexOf(s.phase);
      return i >= 0 && i < STEP_ORDER.length - 1
        ? { phase: STEP_ORDER[i + 1] }
        : {};
    }),
  back: () =>
    set((s) => {
      const i = (STEP_ORDER as readonly Phase[]).indexOf(s.phase);
      return i <= 0
        ? { phase: "intro", selected: null }
        : { phase: STEP_ORDER[i - 1] };
    }),
}));

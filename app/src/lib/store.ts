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

// Narrated steps the prev/next buttons move between. `title` is the caption
// shown on the step. `dur` is the transition length in ms, OR `null` to play at
// constant bike speed — the draw-out steps derive their length from the route
// distances (see PLAYBACK_SPEEDUP) so longer routes take proportionally longer.
export const STEPS = [
  {
    key: "near",
    dur: null,
    title: "How far does a $3 Citi Bike ride take you today?",
  },
  { key: "fade", dur: 1400, title: "We want to subsidize it to 45 minutes." },
  { key: "all", dur: null, title: "Here's how far $3 could take you." },
] as const;

// Constant-bike-speed playback: a `dur: null` step animates at this multiple of
// real ride time (e.g. 120× → a 45-min route draws out in ~22.5s of wall clock).
export const PLAYBACK_SPEEDUP = 140;

export type Phase =
  | "selecting"
  | "selected"
  | "show_near"
  | "fade_near"
  | "show_far"
  | "show_both"
  | "cta"
  | "reset";

export const LAST_STEP = STEPS.length - 1;
export type StepKey = (typeof STEPS)[number]["key"];

// Ordered story phases the Narrator's prev/next controls step through, after a
// station is picked. `selecting` is the intro and `reset` the teardown —
// neither is part of this navigable sequence.
export const PHASE_ORDER = [
  "show_near",
  "fade_near",
  "show_far",
  "show_both",
  "cta",
] as const satisfies readonly Phase[];

interface AppState {
  /** Picked station, or null in the intro. */
  selected: Dock | null;
  /** Pick (or clear) a station; picking enters the story at the first phase. */
  setSelected: (s: Dock | null) => void;
  /** Current story phase; `selecting` while picking in the intro. */
  phase: Phase;
  setPhase: (p: Phase) => void;
  /** Step forward through PHASE_ORDER (no-op at the last phase). */
  advance: () => void;
  /** Step back through PHASE_ORDER; from the first phase, return to the intro. */
  back: () => void;
}

export const useApp = create<AppState>((set) => ({
  selected: null,
  setSelected: (s) =>
    set({ selected: s, phase: s ? PHASE_ORDER[0] : "selecting" }),
  phase: "selecting",
  setPhase: (p) => set({ phase: p }),
  advance: () =>
    set((s) => {
      const i = (PHASE_ORDER as readonly Phase[]).indexOf(s.phase);
      return i >= 0 && i < PHASE_ORDER.length - 1
        ? { phase: PHASE_ORDER[i + 1] }
        : {};
    }),
  back: () =>
    set((s) => {
      const i = (PHASE_ORDER as readonly Phase[]).indexOf(s.phase);
      return i <= 0
        ? { phase: "selecting", selected: null }
        : { phase: PHASE_ORDER[i - 1] };
    }),
}));

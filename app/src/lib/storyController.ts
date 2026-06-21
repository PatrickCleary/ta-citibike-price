// Drives the narrated trip-line story: an imperative rAF loop that tweens a
// step's local progress t ∈ [0,1] and paints each frame. The sibling of
// DockController / TripLines — it owns the animation clock and is triggered
// imperatively (e.g. from UI buttons via playStep), not bound to store phases.
//
// A "frame" is: isolate the picked origin dot, apply origin styling once, and
// set the two trip-line tiers via tiersForPhase. With no station picked it
// paints the intro (full field, full-metro camera, no trips).

import type maplibregl from "maplibre-gl";
import { DockController, STATIONS_LAYER } from "./dockController";
import { TripLines, tiersForPhase, type TierState } from "./tripLines";
import { STEPS, LAST_STEP, PLAYBACK_SPEEDUP, type StepKey } from "./store";
import { FULL_VIEW } from "./constants";

const EMPTY: Set<string> = new Set();
const HIDDEN: TierState = { visible: false, progress: 0, opacity: 1 };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const linear = (t: number) => t; // constant speed — for bike-speed draw-out
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

export class StoryController {
  private raf: number | null = null;
  private applied = false; // origin styling applied for the current pick?

  constructor(
    private map: maplibregl.Map,
    private trips: TripLines,
    private docks: DockController,
    private originFor: (id: string) => [number, number] | null,
    private selectedId: () => string | null,
  ) {}

  // Trigger a named step (e.g. from a UI button). Steps with a fixed `dur` use
  // it (eased); `dur: null` steps play at constant bike speed — duration derived
  // from the route distances, scrubbed linearly so the bead's speed is constant.
  playStep(key: StepKey, onDone?: () => void) {
    const idx = STEPS.findIndex((s) => s.key === key);
    if (idx < 0) return;
    const fixed = STEPS[idx].dur;
    const dur =
      fixed ?? (this.trips.rideSecondsFor(key) * 1000) / PLAYBACK_SPEEDUP;
    this.play(idx, dur, onDone, fixed == null ? linear : easeInOut);
  }

  // Tween `step`'s local progress 0→1 over `dur` ms, painting each frame.
  play(
    step: number,
    dur: number,
    onDone?: () => void,
    ease: (t: number) => number = easeInOut,
  ) {
    this.stop();
    // Kill any in-flight MapLibre camera animation (scroll-zoom easing / drag
    // inertia from the intro) so it can't fight our per-frame paints.
    this.map.stop();
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = dur <= 0 ? 1 : clamp01((now - t0) / dur);
      this.scrub(step, ease(k));
      if (k < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = null;
        this.scrub(step, 1);
        onDone?.();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  // Paint a single static frame (the intro, or holding a step at progress t).
  paint(step: number, t: number) {
    this.scrub(step, t);
  }

  stop() {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  // Clear the per-pick latch so the next pick re-applies origin styling.
  resetPick() {
    this.applied = false;
  }

  dispose() {
    this.stop();
  }

  private scrub(step: number, t: number) {
    const map = this.map;
    const id = this.selectedId();
    const origin = id ? this.originFor(id) : null;

    // Isolate the origin dot once a station is picked; show the full field in
    // the intro so any station stays clickable.
    if (map.getLayer(STATIONS_LAYER)) {
      const want = origin ? id : null;
      const cur = map.getFilter(STATIONS_LAYER) as unknown[] | undefined;
      const curId = Array.isArray(cur) ? (cur[2] as string) : null;
      if (want !== curId) {
        map.setFilter(
          STATIONS_LAYER,
          want ? ["==", ["get", "station_id"], want] : null,
        );
      }
    }

    // Intro: no station picked → full field, full-metro camera, no trips.
    if (!origin) {
      this.trips.setTiers(HIDDEN, HIDDEN);
      map.jumpTo({ center: FULL_VIEW.center, zoom: FULL_VIEW.zoom });
      return;
    }

    // Origin styling: applied once per pick (red marker + a little plop).
    if (!this.applied) {
      this.docks.select({
        selectedId: id!,
        near: EMPTY,
        ring: EMPTY,
        showNear: true,
        showRing: true,
        hideOthers: true,
      });
      this.docks.start();
      this.applied = true;
    }

    // Paint the two trip-line tiers for this step's local progress.
    const idx = step < 0 ? 0 : step > LAST_STEP ? LAST_STEP : step;
    const { near, all } = tiersForPhase(STEPS[idx].key, t);
    this.trips.setTiers(near, all);
  }
}

// Drives the narrated trip-line story as a set of discrete, independently
// re-enterable steps — NOT a scrubbable timeline. The sibling of DockController
// / TripLines: it owns the animation clock and is triggered imperatively from
// the UI (playNear / playFar), while the static resting frames (showIntro /
// showOrigin / holdNear / holdFar) are painted when the store lands on a step.
//
// Each draw-out step still has a private 0→1 progress clock (the bead's position
// is a function of it), but that `t` is never addressed from outside — you only
// ever play a step forward or paint its resting frame.

import type maplibregl from "maplibre-gl";
import { DockController, STATIONS_LAYER } from "./dockController";
import { TripLines, tiersForPhase } from "./tripLines";
import { PLAYBACK_SPEEDUP, type StepKey } from "./store";
import { FULL_VIEW, ORIGIN_EASE_MS, ORIGIN_ZOOM } from "./constants";

const EMPTY: Set<string> = new Set();

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const linear = (t: number) => t; // constant speed — for bike-speed draw-out

export class StoryController {
  private raf: number | null = null;
  private rewind: ReturnType<typeof setTimeout> | null = null;
  private applied = false; // origin styling applied for the current pick?

  constructor(
    private map: maplibregl.Map,
    private trips: TripLines,
    private docks: DockController,
    private originFor: (id: string) => [number, number] | null,
    private selectedId: () => string | null,
  ) {}

  // ── Static resting frames (painted when the store lands on a step) ──────────

  // Intro: no station picked → full field, full-metro camera, no trips.
  showIntro() {
    this.stop();
    this.isolateOrigin(null);
    this.trips.setTiers({ visible: false, progress: 0, opacity: 1 }, { visible: false, progress: 0, opacity: 1 });
    this.map.jumpTo({ center: FULL_VIEW.center, zoom: FULL_VIEW.zoom });
  }

  // Step 1 (selected): isolate + style the picked origin, no trips yet. Leaves
  // the camera alone so the selection flyTo (mapControl) can run uninterrupted.
  showOrigin() {
    this.stop();
    if (!this.hasOrigin()) return this.showIntro();
    this.renderStep("near", 0, { hideTrips: true });
  }

  // Step 2/3 resting frames: the draw-out held at its end (progress 1). Static —
  // the camera stays wherever it is (no auto-fit), so re-entering a step via the
  // reset-to-any-step controls doesn't lurch.
  holdNear() {
    this.stop();
    if (!this.hasOrigin()) return this.showIntro();
    this.renderStep("near", 1);
  }

  holdFar() {
    this.stop();
    if (!this.hasOrigin()) return this.showIntro();
    this.renderStep("far", 1);
  }

  // ── Draw-out animations (triggered by the UI's play buttons) ────────────────

  // Step 2: draw the ≤11 set out at constant bike speed, then hold.
  playNear(onDone?: () => void) {
    this.play("near", onDone);
  }

  // Step 3: draw the full ≤45 set out (all-blue) at constant bike speed.
  playFar(onDone?: () => void) {
    this.play("far", onDone);
  }

  // Re-run a step from the top. The draw-out itself starts wherever the camera
  // is (it only ever frames outward), so a replay first has to undo the zoom-out
  // the last draw left behind: clear the lines, ease back to the origin view the
  // selection landed on, and only then play. onDone fires when the draw settles,
  // same as playNear/playFar.
  replay(key: StepKey, onDone?: () => void) {
    if (!this.rewindToOrigin(key)) return;
    this.rewind = setTimeout(() => {
      this.rewind = null;
      this.play(key, onDone);
    }, ORIGIN_EASE_MS);
  }

  // Clear the drawn lines and ease back to the origin view, without playing
  // anything. Returns false if there's no pick to rewind to. Standalone, this is
  // the "start the story over" frame (the final step's Replay); `replay` chains
  // a draw-out onto it.
  rewindToOrigin(key: StepKey = "near"): boolean {
    this.stop();
    if (!this.hasOrigin()) return false;
    const origin = this.originFor(this.selectedId()!)!;
    this.renderStep(key, 0, { hideTrips: true });
    this.map.stop();
    this.map.easeTo({
      center: origin,
      zoom: ORIGIN_ZOOM,
      duration: ORIGIN_EASE_MS,
    });
    return true;
  }

  stop() {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.rewind != null) {
      clearTimeout(this.rewind);
      this.rewind = null;
    }
    this.trips.endAutoFit();
  }

  // Clear the per-pick latch so the next pick re-applies origin styling.
  resetPick() {
    this.applied = false;
  }

  dispose() {
    this.stop();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  // Tween `key`'s local progress 0→1 at constant bike speed (duration derived
  // from the route distances), painting each frame, then hold at 1.
  private play(key: StepKey, onDone?: () => void) {
    this.stop();
    if (!this.hasOrigin()) return;
    // Kill any in-flight MapLibre camera animation (the selection flyTo, scroll
    // easing, drag inertia) so it can't fight our per-frame paints, then take
    // camera ownership for the draw-out.
    this.map.stop();
    this.trips.beginAutoFit();

    const dur = (this.trips.rideSecondsFor(key) * 1000) / PLAYBACK_SPEEDUP;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = dur <= 0 ? 1 : clamp01((now - t0) / dur);
      this.renderStep(key, linear(k));
      if (k < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = null;
        this.renderStep(key, 1);
        this.trips.endAutoFit();
        onDone?.();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  // Paint one frame of a step: isolate + style the origin, then set the tiers for
  // this step's progress (or hide them entirely for the pre-draw resting frame).
  private renderStep(
    key: StepKey,
    t: number,
    opts?: { hideTrips?: boolean },
  ) {
    const id = this.selectedId()!;
    this.isolateOrigin(id);
    this.ensureOriginStyling(id);
    if (opts?.hideTrips) {
      this.trips.setTiers({ visible: false, progress: 0, opacity: 1 }, { visible: false, progress: 0, opacity: 1 });
      return;
    }
    const { near, all } = tiersForPhase(key, t);
    this.trips.setTiers(near, all);
  }

  private hasOrigin(): boolean {
    const id = this.selectedId();
    return !!(id && this.originFor(id));
  }

  // Isolate the origin dot when a station is picked (`id`); pass null to restore
  // the full clickable field (the intro).
  private isolateOrigin(id: string | null) {
    if (!this.map.getLayer(STATIONS_LAYER)) return;
    const cur = this.map.getFilter(STATIONS_LAYER) as unknown[] | undefined;
    const curId = Array.isArray(cur) ? (cur[2] as string) : null;
    if (id !== curId) {
      this.map.setFilter(
        STATIONS_LAYER,
        id ? ["==", ["get", "station_id"], id] : null,
      );
    }
  }

  // Apply the red origin marker + plop once per pick (latched by `applied`,
  // cleared by resetPick).
  private ensureOriginStyling(id: string) {
    if (this.applied) return;
    this.docks.select({
      selectedId: id,
      near: EMPTY,
      ring: EMPTY,
      showNear: true,
      showRing: true,
      hideOthers: true,
    });
    this.docks.start();
    this.applied = true;
  }
}

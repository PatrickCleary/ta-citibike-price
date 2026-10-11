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
import { DockController } from "./dockController";
import { COLOR_ALL, TripLines, tiersForPhase } from "./tripLines";
import type { WalkshedLayer } from "./walksheds";
import { FAR_ONLY, PLAYBACK_SPEEDUP, type Layers, type StepKey } from "./store";
import { FULL_VIEW, ORIGIN_EASE_MS, ORIGIN_ZOOM } from "./constants";

const EMPTY: Set<string> = new Set();

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const linear = (t: number) => t; // constant speed — for bike-speed draw-out

export class StoryController {
  private raf: number | null = null;
  // The step whose draw-out `raf` is running, so landing on that same step's
  // resting frame (the advance onDone triggers) lets its trails finish fading.
  private playing: StepKey | null = null;
  private rewind: ReturnType<typeof setTimeout> | null = null;
  // Which dock styling is currently baked: a StepKey (that step's arrival
  // delays), or "bare" (origin only). Latched so the per-frame renderStep doesn't
  // re-bake 2.4k feature-states every tick — but keyed by step, not just by pick,
  // because each step bakes different delays.
  private applied: StepKey | "bare" | null = null;

  constructor(
    private map: maplibregl.Map,
    private trips: TripLines,
    private docks: DockController,
    private sheds: WalkshedLayer,
    private originFor: (id: string) => [number, number] | null,
    private selectedId: () => string | null,
  ) {}

  // ── Static resting frames (painted when the store lands on a step) ──────────

  // Intro: no station picked → full field, full-metro camera, no trips.
  showIntro() {
    this.stop();
    this.isolateOrigin(null);
    this.trips.setTiers({ visible: false, progress: 0, opacity: 1 }, { visible: false, progress: 0, opacity: 1 });
    this.sheds.show(null);
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
    if (this.playing === "near") return;
    this.stop();
    if (!this.hasOrigin()) return this.showIntro();
    this.renderStep("near", 1);
  }

  // `layers` is the far step's tier toggle. The default (≤45 only) is exactly
  // the draw-out's last frame, so it lets an in-flight draw-out finish fading;
  // any other choice takes over immediately.
  holdFar(layers: Layers = FAR_ONLY) {
    const isDefault = !layers.near && layers.far;
    if (this.playing === "far" && isDefault) return;
    this.stop();
    if (!this.hasOrigin()) return this.showIntro();
    if (isDefault) return this.renderStep("far", 1);

    const id = this.selectedId()!;
    this.isolateOrigin(id);
    this.ensureDockStyling(id, "far", 1, false);
    this.trips.setTiers(
      { visible: layers.near, progress: 1, opacity: 1 }, // baked orange
      { visible: layers.far, progress: 1, opacity: 1, color: COLOR_ALL },
    );
    this.sheds.showTiers(layers);
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
    this.playing = null;
    if (this.rewind != null) {
      clearTimeout(this.rewind);
      this.rewind = null;
    }
    this.trips.endAutoFit();
  }

  // Clear the latch so the next pick re-applies dock styling from scratch.
  resetPick() {
    this.applied = null;
  }

  dispose() {
    this.stop();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  // Tween `key`'s local progress 0→1 at constant bike speed (duration derived
  // from the route distances), painting each frame, then hold at 1. onDone fires
  // as soon as every trip has docked; the clock runs on until the last trails
  // have faded, so they don't freeze mid-fade.
  private play(key: StepKey, onDone?: () => void) {
    this.stop();
    if (!this.hasOrigin()) return;
    // Kill any in-flight MapLibre camera animation (the selection flyTo, scroll
    // easing, drag inertia) so it can't fight our per-frame paints, then take
    // camera ownership for the draw-out.
    this.map.stop();
    this.trips.beginAutoFit();

    const ride = this.trips.rideSecondsFor(key);
    const dur = (ride * 1000) / PLAYBACK_SPEEDUP;
    const doneAt = ride > 0 ? this.trips.doneSecondsFor(key) / ride : 1;
    let done = false;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = dur <= 0 ? 1 : clamp01((now - t0) / dur);
      this.renderStep(key, linear(k));
      if (!done && k >= doneAt) {
        done = true;
        onDone?.();
      }
      if (k < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = null;
        this.playing = null;
        this.trips.endAutoFit();
      }
    };
    this.playing = key;
    this.raf = requestAnimationFrame(tick);
  }

  // Paint one frame of a step: isolate + style the origin, then set the tiers for
  // this step's progress (or hide them entirely for the pre-draw resting frame).
  // A step's walkshed fades in once every trip has docked (doneSecondsFor).
  private renderStep(
    key: StepKey,
    t: number,
    opts?: { hideTrips?: boolean },
  ) {
    const id = this.selectedId()!;
    this.isolateOrigin(id);
    this.ensureDockStyling(id, key, t, !!opts?.hideTrips);
    if (opts?.hideTrips) {
      this.trips.setTiers({ visible: false, progress: 0, opacity: 1 }, { visible: false, progress: 0, opacity: 1 });
      this.sheds.show(null);
      return;
    }
    const { near, all } = tiersForPhase(key, t);
    this.trips.setTiers(near, all);
    const ride = this.trips.rideSecondsFor(key);
    const docked = t >= 1 || t * ride >= this.trips.doneSecondsFor(key);
    this.sheds.show(docked ? key : null);
  }

  private hasOrigin(): boolean {
    const id = this.selectedId();
    return !!(id && this.originFor(id));
  }

  // Isolate the origin dock when a station is picked (`id`); pass null to
  // restore the full clickable field (the intro). DockController owns the
  // filtering itself now that a dock draws on two layers (dot + pin).
  private isolateOrigin(id: string | null) {
    this.docks.isolate(id);
  }

  // Bake the origin marker and this step's arrival delays into feature-state,
  // once per step (latched by `applied`, cleared by resetPick).
  //
  // `bare` is the pre-draw frame (showOrigin / rewindToOrigin): origin only —
  // the lines haven't ridden out yet, so nothing has arrived.
  private ensureDockStyling(id: string, key: StepKey, t: number, bare: boolean) {
    const tag = bare ? "bare" : key;
    if (this.applied === tag) return;
    this.applied = tag;

    this.docks.select({
      selectedId: id,
      near: EMPTY,
      ring: EMPTY,
      showNear: true,
      showRing: true,
      hideOthers: true,
      delays: bare ? undefined : this.trips.arrivalDelays(key),
    });

    // A draw-out starting from the top (t≈0) plays the wave alongside the lines.
    // A resting frame (holdNear/holdFar land at t=1) has no lines to sync to, so
    // settle instantly — otherwise the wave would replay over an already
    // fully-drawn map.
    if (t >= 1) this.docks.refresh();
    else this.docks.start();
  }
}

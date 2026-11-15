import { useEffect, useState } from "react";
import type { StoryController } from "../lib/storyController";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  RotateCcw,
  Timer,
  X,
} from "lucide-react";
import { FAR_ONLY, useApp, type StepKey } from "../lib/store";
import { useMapStore, useSetMapInteractive } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import NarrationBlock from "./NarrationBlock";
import StoryCopy from "./StoryCopy";
import PickedHeader from "./PickedHeader";
import ReflectPanel from "./ReflectPanel";
import { rgbOf } from "./Legend";
import { AnimatePresence, motion } from "motion/react";

// Bottom-bar buttons. Every one presses in and pops back (PRESS). Round
// icon buttons for Back/Next (labelled on desktop); a quieter pill for
// secondary actions (Replay, Pick another station) that stretches to fill the
// bar's middle. The draw-outs' play buttons live in the overlays that pose
// them (StoryOverlay), not here.
const PRESS =
  "transition-[transform,background-color,color] duration-150 ease-out hover:scale-[1.03] active:scale-95 disabled:hover:scale-100 disabled:active:scale-100";
// NAV_BTN and NAV_PRIMARY share one footprint (padding, weight) and differ
// only in colour, so Next can switch between them — grey while a draw-out
// plays, blue once the step lands — without changing width and shoving the
// middle of the bar around.
const NAV_BASE = `${PRESS} pointer-events-auto inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full px-3 text-sm font-medium shadow-lg disabled:cursor-default`;
const NAV_BTN = `${NAV_BASE} bg-white/90 text-gray-800 backdrop-blur hover:bg-white disabled:text-gray-300`;
const NAV_PRIMARY = `${NAV_BASE} bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`;
const ALT_BTN = `${PRESS} pointer-events-auto inline-flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-white/90 px-4 text-sm font-medium text-gray-800 shadow-lg backdrop-blur hover:bg-white disabled:cursor-default disabled:text-gray-300`;

// Ride clock shown while trips draw out: counts 0:00 → the tier's budget,
// reaching it exactly as the last trip docks. Scaled to the draw-out rather than
// literal ride time (a few routes run past their tier's minutes), so it always
// lands on 11:00 / 45:00. Polls the story each frame; only this re-renders.
const CLOCK_MINUTES: Record<StepKey, number> = { near: 11, far: 45 };

function RideClock({ story }: { story: StoryController }) {
  const [p, setP] = useState(() => story.rideProgress());
  useEffect(() => {
    let raf = requestAnimationFrame(function tick() {
      setP(story.rideProgress());
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [story]);
  if (!p) return null;

  const total = CLOCK_MINUTES[p.key] * 60;
  const secs = Math.floor(Math.min(1, p.frac) * total);
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const [r, g, b] = rgbOf(p.key);
  return (
    <div className="pointer-events-auto inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-white/90 px-4 shadow-lg backdrop-blur">
      <Timer size={18} style={{ color: `rgb(${r},${g},${b})` }} />
      {/* Monospace and a fixed 5ch box, so the digits don't jitter as they
          tick or shift when the minutes reach two digits. */}
      <span className="min-w-[5ch] font-mono text-lg font-semibold text-gray-900">
        {mmss}
      </span>
    </div>
  );
}

// The near step is just the finished draw-out, left to sit for this long with
// nothing over it before the story moves on to the reflect panel.
const NEAR_PAUSE_MS = 2000;

// Three pieces, all portalled to body: the full-screen overlays that pose each
// draw-out (PickedHeader before near, ReflectPanel before far), the later
// steps' narrative beats centred on screen (StoryCopy), and the bottom control
// bar (every other control). The bar always
// has Back/Next, so any step can step to its neighbour; its middle holds the
// step's own actions — the play buttons, Replay, and the far step's layer
// toggle — which are separate from navigation. Renders nothing in place; the
// top-left card is StepLegend, mounted by Map.tsx only on the steps that have
// a map key. Not mounted in the intro (Map.tsx shows just the search bar there).
export default function Narrator({
  boroughOf,
}: {
  boroughOf: (id: string) => string | null;
}) {
  const phase = useApp((s) => s.phase);
  const selected = useApp((s) => s.selected);
  const advance = useApp((s) => s.advance);
  const back = useApp((s) => s.back);
  const setLayers = useApp((s) => s.setLayers);
  const exploring = useApp((s) => s.exploring);
  const setExploring = useApp((s) => s.setExploring);
  const watched = useApp((s) => s.watched);
  const markWatched = useApp((s) => s.markWatched);
  const story = useMapStore((s) => s.story);
  const resetMap = useResetMap();
  // A draw-out (or a replay's rewind into one) is running.
  const [busy, setBusy] = useState(false);
  // The selection ease (see mapControl) hasn't landed yet. Narrator mounts
  // with the pick itself, so it starts out easing; otherwise the first render
  // would flash PickedHeader up before the effect below could hold it back.
  const [easing, setEasing] = useState(
    () => useApp.getState().phase === "selected",
  );
  const setMapInteractive = useSetMapInteractive();

  // Gate the controls for the duration of the selection ease so a draw-out
  // can't start before the camera settles on the origin.
  useEffect(() => {
    // Only a fresh pick flies the camera; a far-step switch stays put.
    if (!selected || useApp.getState().phase !== "selected") return;
    setEasing(true);
    const id = setTimeout(
      () => setEasing(false),
      useMapStore.getState().originEaseMs,
    );
    return () => {
      clearTimeout(id);
      setEasing(false);
    };
  }, [selected?.id]);

  // The near step carries itself: the finished draw-out sits for
  // NEAR_PAUSE_MS, then the story moves on to the reflect panel.
  useEffect(() => {
    if (phase !== "near" || busy) return;
    const id = setTimeout(advance, NEAR_PAUSE_MS);
    return () => clearTimeout(id);
  }, [phase, busy]);

  // Play a draw-out step, then advance to the next step once it settles.
  const play = (which: StepKey) => {
    if (!story) return;
    setBusy(true);
    const done = () => {
      setBusy(false);
      markWatched(which);
      advance();
      setMapInteractive(true);
    };
    if (which === "near") story.playNear(done);
    else story.playFar(done);
  };

  // Re-run the step we're already on: rewind to the origin view and draw it out
  // again, staying put rather than advancing.
  const replay = (which: StepKey) => {
    if (!story) return;
    setBusy(true);
    if (which === "far") setLayers(FAR_ONLY); // the draw-out is ≤45-only
    story.replay(which, () => setBusy(false));
  };

  // Navigation. Back from the first step leaves the station entirely. Stepping
  // (rather than playing) past a draw-out lands on its resting frame, so the map
  // is handed back to the user just as a finished draw-out would.
  const goBack = () => (phase === "selected" ? resetMap() : back());
  // A step that poses a draw-out can't be skipped until it's been watched.
  const gated =
    (phase === "selected" && !watched.near) ||
    (phase === "reflect" && !watched.far);
  const goNext = () => {
    advance();
    setMapInteractive(true);
  };
  // Next is the suggested action on every step except the two whose play
  // button is (there it stays a plain nav button, enabled only once watched).
  const primaryNext = phase !== "selected" && phase !== "reflect";
  // The two steps that pose a draw-out are all overlay until it starts; then
  // the overlay steps aside and the bar comes up with the ride clock. The first
  // one waits for the selection ease to land, so the dock arrives first and the
  // question follows.
  const posing = (phase === "selected" || phase === "reflect") && !busy;
  const showHeader = posing && phase === "selected" && !easing;
  const showReflect = posing && phase === "reflect";
  // No bar on the near step either: it's a beat to look at the result, and it
  // moves on by itself.
  const showBar = !!selected && !posing && phase !== "near";

  // The step's own actions, between Back and Next. While busy (the selection
  // flyTo, or a draw-out playing) the ride clock takes their place instead —
  // it renders nothing outside a draw-out.
  const actions = (() => {
    switch (phase) {
      case "far":
        return (
          <>
            {/* The tier toggle lives in the legend card (StepLegend). */}
            {!exploring && (
              <button className={ALT_BTN} onClick={() => replay("far")}>
                <RotateCcw size={16} />
                Replay
              </button>
            )}
            {/* One-shot: on, pick a dock on the map, and it switches off. */}
            <button
              className={`${NAV_BTN} min-w-0 flex-1`}
              aria-pressed={exploring}
              aria-label={
                exploring ? "Cancel picking a station" : "Pick another station"
              }
              title={exploring ? "Cancel" : "Pick another station"}
              onClick={() => setExploring(!exploring)}
            >
              {exploring ? <X size={16} /> : <MapPin size={16} />}
              <span className="hidden pr-1 md:inline">
                {exploring ? "Cancel" : "Another station"}
              </span>
            </button>
          </>
        );
      case "final":
        return (
          <button className={ALT_BTN} onClick={() => resetMap()}>
            <RotateCcw size={16} />
            Reset
          </button>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      {/* Portalled to body: a `fixed` bar inside a backdrop-blurred card
          would take the card as its containing block and get pinned inside it. */}
      {createPortal(
        <AnimatePresence>
          {showHeader && selected && (
            <PickedHeader
              key="picked"
              name={selected.name}
              borough={boroughOf(selected.id)}
              onPlay={() => play("near")}
              onChangeStation={resetMap}
            />
          )}
          {showReflect && (
            <ReflectPanel key="reflect-panel" onPlay={() => play("far")} />
          )}
        </AnimatePresence>,
        document.body,
      )}
      {createPortal(<StoryCopy />, document.body)}
      {createPortal(
        showBar && (
          <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center p-4 pb-6 md:pb-10">
            {/* Fixed-width row: Back and Next pin to the edges, the step's own
                actions (or the ride clock) stretch across the middle. */}
            <div className="flex w-full max-w-xl items-center justify-between gap-2">
              <button
                className={NAV_BTN}
                aria-label="Back"
                disabled={busy || easing}
                onClick={goBack}
              >
                <ChevronLeft size={20} />
                <span className="hidden pr-1 md:inline">Back</span>
              </button>

              <AnimatePresence mode="wait">
                {busy && story ? (
                  <motion.div
                    key="clock"
                    className="flex min-w-0 flex-1 items-center justify-center"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                  >
                    <RideClock story={story} />
                  </motion.div>
                ) : (
                  actions && (
                    <motion.div
                      key={phase}
                      className="flex min-w-0 flex-1 items-center justify-center gap-2"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.2 }}
                    >
                      {actions}
                    </motion.div>
                  )
                )}
              </AnimatePresence>

              {phase !== "final" ? (
                <button
                  className={primaryNext ? NAV_PRIMARY : NAV_BTN}
                  aria-label="Next"
                  title={gated ? "Watch the animation first" : undefined}
                  disabled={busy || easing || gated}
                  onClick={goNext}
                >
                  <span className="hidden pl-1 md:inline">Next</span>
                  <ChevronRight size={20} />
                </button>
              ) : (
                // Same footprint as Next, so Back and the middle stay put on
                // the last step instead of sliding over.
                <span aria-hidden className={`${NAV_BTN} invisible`}>
                  <span className="hidden pl-1 md:inline">Next</span>
                  <ChevronRight size={20} />
                </span>
              )}
            </div>
          </div>
        ),
        document.body,
      )}
    </>
  );
}

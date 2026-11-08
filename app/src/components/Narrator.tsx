import { useEffect, useState } from "react";
import type { StoryController } from "../lib/storyController";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Play,
  MapPin,
  RotateCcw,
  Timer,
  X,
} from "lucide-react";
import { FAR_ONLY, useApp, type Layers, type StepKey } from "../lib/store";
import { useMapStore, useSetMapInteractive } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import { ORIGIN_EASE_MS } from "../lib/constants";
import { useRoutes } from "../lib/queries";
import NarrationBlock from "./NarrationBlock";
import StoryCopy from "./StoryCopy";
import { COLOR_ALL, COLOR_NEAR } from "../lib/tripLines";
import { TIERS } from "../lib/walksheds";
import { AnimatePresence, motion } from "motion/react";

// Bottom-bar buttons. Every one presses in and pops back (PRESS). Round
// icon buttons for Back/Next (labelled on desktop); a quieter pill for
// secondary actions (Replay, Pick another station) that stretches to fill the
// bar's middle; and the blue primary for whatever the step suggests you do
// next — the play button on the two steps that pose a draw-out, Next
// everywhere else.
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
const PRIMARY_BTN = `${PRESS} pointer-events-auto inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full bg-blue-600 px-5 text-sm font-semibold text-white shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-default`;

// Map key for a draw-out step: how many docks the tier reaches, in the colour
// its trip dots and walkshed fill are painted (orange for near; the far step
// recolours everything indigo), then one quiet line for the shaded walksheds.
// Each label has a short form for phones, where the card is ~260px wide and
// the full sentence wraps the count onto two lines.
const LEGEND_LABELS: Record<StepKey, { full: string; short: string }> = {
  near: {
    full: "stations within a $3 fare today (11 min)",
    short: "stations, $3 today (11 min)",
  },
  far: {
    full: "stations within a $3 capped fare (45 min)",
    short: "stations, $3 capped (45 min)",
  },
};
const TIER_KEY: Record<StepKey, "11" | "45"> = { near: "11", far: "45" };

const rgbOf = (step: StepKey) => (step === "near" ? COLOR_NEAR : COLOR_ALL);

// One row per tier. On the far step the rows ARE the tier toggle: `layers` +
// `onToggle` make each row a button with a check indicator, dimmed while off,
// and the last row left on can't be switched off. Without them (the near
// step) the rows are static, with the same indicator always checked so the
// two steps read alike.
function Legend({
  steps,
  layers,
  onToggle,
}: {
  steps: StepKey[];
  layers?: Layers;
  onToggle?: (step: StepKey) => void;
}) {
  const selected = useApp((s) => s.selected);
  // Same query Map.tsx fires on pick, so this is a cache hit by the time the
  // near step shows. The 45 set is a superset of 11, so each is a plain count.
  const routes = useRoutes(selected?.id ?? null).data;
  const isOn = (step: StepKey) => (layers ? layers[step] : true);
  const shown = steps.filter(isOn);
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="-mx-1.5 flex flex-col text-xs text-gray-800 md:text-sm">
        {steps.map((step) => {
          const [r, g, b] = rgbOf(step);
          const rgb = `rgb(${r},${g},${b})`;
          const on = isOn(step);
          const last = on && shown.length === 1;
          const count = routes
            ? Object.keys(routes[TIER_KEY[step]]).length
            : null;
          const row = (
            <>
              <span
                aria-hidden
                className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  on ? "text-white" : "border-gray-300 bg-transparent"
                }`}
                style={on ? { background: rgb, borderColor: rgb } : undefined}
              >
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <span
                className={`text-lg font-semibold tabular-nums transition-colors md:text-xl ${
                  on ? "" : "text-gray-400"
                }`}
                style={on ? { color: rgb } : undefined}
              >
                {count == null ? "—" : count.toLocaleString()}
              </span>
              <span className={on ? "" : "text-gray-400"}>
                <span className="md:hidden">{LEGEND_LABELS[step].short}</span>
                <span className="hidden md:inline">
                  {LEGEND_LABELS[step].full}
                </span>
              </span>
            </>
          );
          return (
            <li key={step}>
              {onToggle ? (
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={last}
                  title={last ? "At least one layer stays on" : undefined}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left whitespace-nowrap transition-colors hover:bg-black/5 disabled:cursor-default disabled:hover:bg-transparent md:gap-2"
                  onClick={() => onToggle(step)}
                >
                  {row}
                </button>
              ) : (
                <span className="flex items-center gap-1.5 px-1.5 py-0.5 whitespace-nowrap md:gap-2">
                  {row}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="flex shrink-0 gap-1">
          {shown.map((step) => {
            const [r, g, b] = rgbOf(step);
            return (
              <span
                key={step}
                className="size-3 rounded-sm border"
                style={{
                  background: `rgba(${r},${g},${b},${TIERS[step].fill})`,
                  borderColor: TIERS[step].color,
                }}
              />
            );
          })}
        </span>
        5-minute walk from a reachable station
      </p>
    </div>
  );
}

// The top-left card's content: the current step's map key. Only the two
// draw-out steps have one; Map.tsx hides the card for every other step.
export function StepLegend() {
  const phase = useApp((s) => s.phase);
  const layers = useApp((s) => s.layers);
  const setLayers = useApp((s) => s.setLayers);
  const exploring = useApp((s) => s.exploring);
  if (phase === "near") return <Legend steps={["near"]} />;
  if (phase === "far") {
    if (exploring) {
      return (
        <p className="text-sm text-gray-800">
          Tap any station on the map to see how far it gets you.
        </p>
      );
    }
    return (
      <Legend
        steps={["near", "far"]}
        layers={layers}
        onToggle={(k) => setLayers({ ...layers, [k]: !layers[k] })}
      />
    );
  }
  return null;
}

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
      <span className="w-14 text-right text-lg font-semibold tabular-nums text-gray-900">
        {mmss}
      </span>
      <span className="text-sm text-gray-500">
        / {CLOCK_MINUTES[p.key]} min
      </span>
    </div>
  );
}

// The play button's label on each step that poses a draw-out. Short noun
// phrases: the play icon already says "watch", and the step's story copy has
// just posed the question.
const PROMPTS = {
  selected: { step: "near", label: "$3.00 on Citi Bike today" },
  capped: { step: "far", label: "$3.00 on a subsidized Citi Bike" },
} as const satisfies Partial<Record<string, { step: StepKey; label: string }>>;

// Two pieces, both portalled to body: the story's narrative beats centred on
// screen (StoryCopy) and the bottom control bar (every control). The bar always
// has Back/Next, so any step can step to its neighbour; its middle holds the
// step's own actions — the play buttons, Replay, and the far step's layer
// toggle — which are separate from navigation. Renders nothing in place; the
// top-left card is StepLegend, mounted by Map.tsx only on the steps that have
// a map key. Not mounted in the intro (Map.tsx shows just the search bar there).
export default function Narrator() {
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
  const [busy, setBusy] = useState(false);
  const setMapInteractive = useSetMapInteractive();

  // Gate the controls for the duration of the selection flyTo (see mapControl)
  // so a draw-out can't start before the camera settles on the origin.
  useEffect(() => {
    // Only a fresh pick flies the camera; a far-step switch stays put.
    if (!selected || useApp.getState().phase !== "selected") return;
    setBusy(true);
    const id = setTimeout(() => setBusy(false), ORIGIN_EASE_MS);
    return () => clearTimeout(id);
  }, [selected?.id]);

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
    (phase === "capped" && !watched.far);
  const goNext = () => {
    advance();
    setMapInteractive(true);
  };
  // Next is the suggested action on every step except the two whose play
  // button is (there it stays a plain nav button, enabled only once watched).
  const primaryNext = phase !== "selected" && phase !== "capped";

  // The step's own actions, between Back and Next. While busy (the selection
  // flyTo, or a draw-out playing) the ride clock takes their place instead —
  // it renders nothing outside a draw-out.
  const actions = (() => {
    switch (phase) {
      case "selected":
      case "capped": {
        const prompt = PROMPTS[phase];
        return (
          <button
            className={`${PRIMARY_BTN} min-h-11 min-w-0 flex-1 py-2 text-center leading-tight md:text-base`}
            onClick={() => play(prompt.step)}
          >
            <Play size={18} fill="currentColor" className="shrink-0" />
            {prompt.label}
          </button>
        );
      }
      case "near":
        return (
          <button className={ALT_BTN} onClick={() => replay("near")}>
            <RotateCcw size={16} />
            Replay
          </button>
        );
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
      {createPortal(<StoryCopy />, document.body)}
      {createPortal(
        selected && (
          <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center p-4 pb-6 md:pb-10">
            {/* Fixed-width row: Back and Next pin to the edges, the step's own
                actions (or the ride clock) stretch across the middle. */}
            <div className="flex w-full max-w-xl items-center justify-between gap-2">
              <button
                className={NAV_BTN}
                aria-label="Back"
                disabled={busy}
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
                  disabled={busy || gated}
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

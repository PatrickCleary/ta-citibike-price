import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Play, RotateCcw } from "lucide-react";
import { FAR_ONLY, useApp, type Layers, type StepKey } from "../lib/store";
import { useMapStore, useSetMapInteractive } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import { ORIGIN_EASE_MS } from "../lib/constants";
import NarrationBlock from "./NarrationBlock";
import { COLOR_ALL, COLOR_NEAR } from "../lib/tripLines";
import { TIERS } from "../lib/walksheds";
import { AnimatePresence, motion } from "motion/react";

// Bottom-bar buttons. Round icon buttons for Back/Next (labelled on desktop),
// a quieter pill for secondary actions (Replay, Pick another station).
const NAV_BTN =
  "pointer-events-auto inline-flex h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-full bg-white/90 px-3 text-sm font-medium text-gray-800 shadow-lg backdrop-blur hover:bg-white disabled:cursor-default disabled:text-gray-300";
const ALT_BTN =
  "pointer-events-auto inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-white/90 px-4 text-sm font-medium text-gray-800 shadow-lg backdrop-blur hover:bg-white disabled:cursor-default disabled:text-gray-300";

const STATE_RANKS = {
  intro: 0,
  selected: 1,
  near: 2,
  reflect: 3,
  capped: 4,
  far: 5,
  compare: 6,
  final: 7,
};

// Map key for a draw-out step: the docked trip dots, and the walkshed fill in
// the colour and opacity WalkshedLayer paints that step in (orange for near;
// the far step recolours everything indigo).
const LEGEND_LABELS: Record<StepKey, string> = {
  near: "Stations within a $3 fare today (11 min)",
  far: "Stations within a $3 capped fare (45 min)",
};

const rgbOf = (step: StepKey) => (step === "near" ? COLOR_NEAR : COLOR_ALL);

function Legend({ steps }: { steps: StepKey[] }) {
  return (
    <ul className="mb-1 flex flex-col gap-1.5 text-sm text-gray-700">
      {steps.map((step) => {
        const [r, g, b] = rgbOf(step);
        return (
          <li key={step} className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full ring-1 ring-white"
                style={{ background: `rgb(${r},${g},${b})` }}
              />
              {LEGEND_LABELS[step]}
            </span>
            <span className="flex items-center gap-2">
              <span
                className="size-3 shrink-0 rounded-sm border"
                style={{
                  background: `rgba(${r},${g},${b},${TIERS[step].fill})`,
                  borderColor: TIERS[step].color,
                }}
              />
              5-minute walk from a reachable station
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// The far step's tier toggle: a segment per tier, each independently on/off,
// but never both off.
const TOGGLES: { step: StepKey; label: string; short: string }[] = [
  { step: "near", label: "Today · 11 min", short: "11 min" },
  { step: "far", label: "Subsidized · 45 min", short: "45 min" },
];

function LayerToggle({
  layers,
  onChange,
}: {
  layers: Layers;
  onChange: (l: Layers) => void;
}) {
  return (
    <div className="pointer-events-auto flex gap-1 rounded-full bg-white/90 p-1 shadow-lg backdrop-blur">
      {TOGGLES.map(({ step, label, short }) => {
        const on = layers[step];
        const last = on && !layers[step === "near" ? "far" : "near"];
        const [r, g, b] = rgbOf(step);
        return (
          <button
            key={step}
            aria-pressed={on}
            disabled={last}
            title={last ? "At least one layer stays on" : undefined}
            className="flex cursor-pointer items-center gap-2 rounded-full px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-default md:px-4"
            style={
              on
                ? { background: `rgb(${r},${g},${b})`, color: "white" }
                : { color: "#374151" }
            }
            onClick={() => onChange({ ...layers, [step]: !on })}
          >
            <span
              className="size-2.5 rounded-full"
              style={{ background: on ? "white" : `rgb(${r},${g},${b})` }}
            />
            <span className="md:hidden">{short}</span>
            <span className="hidden md:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// The mid-story call to action for each step that poses a draw-out.
const PROMPTS = {
  selected: {
    step: "near",
    tap: "Tap to see how far $3.00 gets you today",
    watch: "Watch how far $3.00 gets you today",
  },
  capped: {
    step: "far",
    tap: "Tap to see how far $3.00 could get you",
    watch: "Watch how far $3.00 could get you",
  },
} as const satisfies Partial<
  Record<string, { step: StepKey; tap: string; watch: string }>
>;

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? "20%" : "-20%",
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? "-20%" : "20%",
    opacity: 0,
  }),
};

// Two pieces: the narration card (top-left, rendered in place — text and
// legends only) and the bottom control bar (portalled — every control). The bar
// always has Back/Next, so any step can step to its neighbour; its middle holds
// the step's own actions — the play buttons, Replay, and the far step's layer
// toggle — which are separate from navigation. Not mounted in the intro
// (Map.tsx shows just the search bar there).
export default function Narrator() {
  const phase = useApp((s) => s.phase);
  const selected = useApp((s) => s.selected);
  const advance = useApp((s) => s.advance);
  const back = useApp((s) => s.back);
  const layers = useApp((s) => s.layers);
  const setLayers = useApp((s) => s.setLayers);
  const setPhase = useApp((s) => s.setPhase);
  const story = useMapStore((s) => s.story);
  const resetMap = useResetMap();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const setMapInteractive = useSetMapInteractive();

  const [prevPhase, setPrevPhase] = useState(phase);
  const [direction, setDirection] = useState(0);

  if (phase !== prevPhase) {
    const currentRank = STATE_RANKS[prevPhase];
    const nextRank = STATE_RANKS[phase];

    setDirection(nextRank > currentRank ? 1 : -1);
    setPrevPhase(phase);
  }

  // Gate the controls for the duration of the selection flyTo (see mapControl)
  // so a draw-out can't start before the camera settles on the origin.
  useEffect(() => {
    if (!selected) return;
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

  // Start the whole story over: back to the first step, rewinding the camera to
  // the origin so the near play button draws out from the zoomed-in view again.
  const restart = () => {
    if (!story?.rewindToOrigin()) return;
    setPhase("selected");
    setBusy(true);
    setTimeout(() => setBusy(false), ORIGIN_EASE_MS);
  };

  // Navigation. Back from the first step leaves the station entirely. Stepping
  // (rather than playing) past a draw-out lands on its resting frame, so the map
  // is handed back to the user just as a finished draw-out would.
  const goBack = () => (phase === "selected" ? resetMap() : back());
  const goNext = () => {
    advance();
    setMapInteractive(true);
  };

  useEffect(() => {
    setHidden(false);
  }, [phase]);

  // The step's own actions, between Back and Next. Hidden while busy (the
  // selection flyTo, or a draw-out playing) — there's nothing to do then.
  const actions = (() => {
    switch (phase) {
      case "selected":
      case "capped": {
        const prompt = PROMPTS[phase];
        return (
          <>
            <button
              className="pointer-events-auto inline-flex min-h-11 cursor-pointer items-center rounded-full bg-white/90 px-5 py-2 text-center text-sm leading-tight font-medium text-gray-900 shadow-lg backdrop-blur md:hidden"
              onClick={() => play(prompt.step)}
            >
              {prompt.tap}
            </button>
            <button
              className="pointer-events-auto hidden h-11 cursor-pointer items-center gap-2 rounded-full bg-blue-600 px-6 text-base font-semibold text-white shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 md:inline-flex"
              onClick={() => play(prompt.step)}
            >
              <Play size={18} fill="currentColor" />
              {prompt.watch}
            </button>
          </>
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
            <LayerToggle layers={layers} onChange={setLayers} />
            <button
              className={NAV_BTN}
              aria-label="Replay"
              title="Replay"
              onClick={() => replay("far")}
            >
              <RotateCcw size={16} />
            </button>
          </>
        );
      case "final":
        return (
          <>
            <button className={ALT_BTN} onClick={restart}>
              <RotateCcw size={16} />
              Replay
            </button>
            <button className={ALT_BTN} onClick={() => resetMap()}>
              Pick another station
            </button>
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="pointer-events-auto flex flex-col gap-1">
      <AnimatePresence initial={false}>
        {!hidden && (
          <div className="flex flex-col w-full mt-2 md:mb-2">
            <AnimatePresence initial={false} custom={direction} mode="wait">
              <motion.div
                key={phase} // Triggers animation when Zustand phase updates
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                style={{
                  width: "100%",
                  height: "100%",
                }}
              >
                {phase === "near" && <Legend steps={["near"]} />}

                {phase === "reflect" && (
                  <>
                    <p>
                      This is how far a $3 ride on a Citi Bike can take you
                      currently.
                    </p>
                    <p>
                      That’s not very far at all — does that get you to work, to
                      your friends’ apartments?
                    </p>
                  </>
                )}

                {phase === "capped" && (
                  <p>
                    Now, if New York subsidized Citi Bike — like it subsidizes
                    every bus, train, and ferry — three dollars could get you a
                    45-minute ride.
                  </p>
                )}

                {phase === "far" && (
                  <Legend
                    steps={(["near", "far"] as StepKey[]).filter(
                      (k) => layers[k],
                    )}
                  />
                )}

                {phase === "compare" && (
                  <>
                    <p>This is how far you could ride.</p>
                    <p>
                      That's a huge difference in how far you can get for the
                      same price!
                    </p>
                  </>
                )}

                {phase === "final" && (
                  <p>
                    Placeholder for TA copy about the campaign and links to
                    resources, etc.
                  </p>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>
      {/* The bottom control bar. Portalled out because the card's backdrop-blur
          would otherwise become the containing block for `fixed` and pin it
          inside the card. */}
      {createPortal(
        selected && (
          <div className="pointer-events-none fixed inset-x-0 bottom-0 flex items-center justify-center gap-2 p-4 pb-10">
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
              {!busy && actions && (
                <motion.div
                  key={phase}
                  className="flex min-w-0 shrink items-center gap-2"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  {actions}
                </motion.div>
              )}
            </AnimatePresence>

            {phase !== "final" && (
              <button
                className={NAV_BTN}
                aria-label="Next"
                disabled={busy}
                onClick={goNext}
              >
                <span className="hidden pl-1 md:inline">Next</span>
                <ChevronRight size={20} />
              </button>
            )}
          </div>
        ),
        document.body,
      )}
      {!hidden && (
        <button
          className="w-full flex justify-center md:hidden text-gray-400"
          onClick={() => setHidden(true)}
        >
          <svg width="2em" height="2em" viewBox="0 0 24 24">
            <path d="M0 0h24v24H0z" fill="none" />
            <path
              fill="currentColor"
              d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6l-6 6z"
            />
          </svg>
        </button>
      )}
      {hidden && (
        <button
          className="w-full flex justify-center md:hidden text-gray-400"
          onClick={() => setHidden(false)}
        >
          <svg width="2em" height="2em" viewBox="0 0 24 24">
            <path d="M0 0h24v24H0z" fill="none" />
            <path
              fill="currentColor"
              d="M7.41 8.58L12 13.17l4.59-4.59L18 10l-6 6l-6-6z"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

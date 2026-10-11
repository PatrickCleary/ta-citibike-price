import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Play } from "lucide-react";
import { FAR_ONLY, useApp, type Layers, type StepKey } from "../lib/store";
import { useMapStore, useSetMapInteractive } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import { ORIGIN_EASE_MS } from "../lib/constants";
import NarrationBlock from "./NarrationBlock";
import { COLOR_ALL, COLOR_NEAR } from "../lib/tripLines";
import { TIERS } from "../lib/walksheds";
import { AnimatePresence, motion } from "motion/react";

const BTN =
  "pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-default disabled:bg-gray-300 disabled:pointer-events-none";

// Secondary action (Replay) — same shape, quieter, so the primary step button
// stays the obvious next move.
const BTN_ALT =
  "pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-default disabled:border-gray-200 disabled:text-gray-400 disabled:pointer-events-none";

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
const TOGGLES: { step: StepKey; label: string }[] = [
  { step: "near", label: "Today · 11 min" },
  { step: "far", label: "Subsidized · 45 min" },
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
      {TOGGLES.map(({ step, label }) => {
        const on = layers[step];
        const last = on && !layers[step === "near" ? "far" : "near"];
        const [r, g, b] = rgbOf(step);
        return (
          <button
            key={step}
            aria-pressed={on}
            disabled={last}
            title={last ? "At least one layer stays on" : undefined}
            className="flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:cursor-default"
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
            {label}
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

// Floating caption + step controls. Each step shows a caption and an explicit
// play/next button; the two draw-out steps (`near`, `far`) trigger the animation
// and advance to the next step when it finishes. Not mounted in the intro
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
  // the origin so "Show me" draws out from the zoomed-in view again.
  const restart = () => {
    if (!story?.rewindToOrigin()) return;
    setPhase("selected");
    setBusy(true);
    setTimeout(() => setBusy(false), ORIGIN_EASE_MS);
  };

  useEffect(() => {
    setHidden(false);
  }, [phase]);

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
                {phase === "selected" && selected && (
                  <button
                    className="pointer-events-auto mb-2 cursor-pointer text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
                    onClick={() => resetMap()}
                  >
                    Select a different station
                  </button>
                )}

                {phase === "near" && (
                  <>
                    <Legend steps={["near"]} />
                    <div className="flex gap-2">
                      <button
                        className={BTN_ALT}
                        disabled={busy}
                        onClick={() => replay("near")}
                      >
                        Replay
                      </button>
                      <button
                        className={BTN}
                        disabled={busy}
                        onClick={() => advance()}
                      >
                        Next
                      </button>
                    </div>
                  </>
                )}

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
                    <div className="flex gap-2">
                      <button className={BTN_ALT} onClick={() => back()}>
                        Back
                      </button>
                      <button className={BTN} onClick={() => advance()}>
                        Next
                      </button>
                    </div>
                  </>
                )}

                {phase === "capped" && (
                  <p className="pb-2">
                    Now, if New York subsidized Citi Bike — like it subsidizes
                    every bus, train, and ferry — three dollars could get you a
                    45-minute ride.
                  </p>
                )}

                {phase === "far" && (
                  <>
                    <Legend steps={(["near", "far"] as StepKey[]).filter((k) => layers[k])} />
                    <div className="flex gap-2">
                      <button
                        className={BTN_ALT}
                        disabled={busy}
                        onClick={() => replay("far")}
                      >
                        Replay
                      </button>
                      <button
                        className={BTN}
                        disabled={busy}
                        onClick={() => advance()}
                      >
                        Next
                      </button>
                    </div>
                  </>
                )}

                {phase === "compare" && (
                  <>
                    <p>This is how far you could ride.</p>
                    <p>
                      That's a huge difference in how far you can get for the
                      same price!
                    </p>
                    <div className="flex gap-2">
                      <button className={BTN_ALT} onClick={() => back()}>
                        Back
                      </button>
                      <button className={BTN} onClick={() => advance()}>
                        Amazing — let's make it happen
                      </button>
                    </div>
                  </>
                )}

                {phase === "final" && (
                  <>
                    <p>
                      Placeholder for TA copy about the campaign and links to
                      resources, etc.
                    </p>
                    <div className="flex gap-2">
                      <button className={BTN} onClick={restart}>
                        Replay
                      </button>
                      <button className={BTN} onClick={() => resetMap()}>
                        Pick another station
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </AnimatePresence>
      {/* The selected step's call to action sits low and centred over the map. It's
          portalled out because the card's backdrop-blur would otherwise become
          the containing block for `fixed` and pin it inside the card. Waits out
          the selection flyTo (busy) so it can't start a draw-out mid-flight. */}
      {createPortal(
        <AnimatePresence>
          {(phase === "selected" || phase === "capped") && selected && !busy && (
            <motion.div
              key={`play-prompt-${phase}`}
              className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center p-4 pb-12"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              <button
                className="pointer-events-auto cursor-pointer rounded-full bg-white/90 px-5 py-3 text-base font-medium text-gray-900 shadow-lg backdrop-blur md:hidden"
                onClick={() => play(PROMPTS[phase].step)}
              >
                {PROMPTS[phase].tap}
              </button>
              <button
                className="pointer-events-auto hidden cursor-pointer items-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 md:inline-flex"
                onClick={() => play(PROMPTS[phase].step)}
              >
                <Play size={18} fill="currentColor" />
                {PROMPTS[phase].watch}
              </button>
            </motion.div>
          )}
          {phase === "far" && selected && !busy && (
            <motion.div
              key="layer-toggle"
              className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center p-4 pb-12"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              <LayerToggle layers={layers} onChange={setLayers} />
            </motion.div>
          )}
        </AnimatePresence>,
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

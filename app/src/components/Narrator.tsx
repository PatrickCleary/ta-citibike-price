import { useEffect, useState } from "react";
import { useApp, type StepKey } from "../lib/store";
import { useMapStore, useSetMapInteractive } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import { ORIGIN_EASE_MS } from "../lib/constants";
import NarrationBlock from "./NarrationBlock";

const BTN =
  "pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-default disabled:bg-gray-300 disabled:pointer-events-none";

// Secondary action (Replay) — same shape, quieter, so the primary step button
// stays the obvious next move.
const BTN_ALT =
  "pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-default disabled:border-gray-200 disabled:text-gray-400 disabled:pointer-events-none";

// Floating caption + step controls. Each step shows a caption and an explicit
// play/next button; the two draw-out steps (`near`, `far`) trigger the animation
// and advance to the next step when it finishes. Renders nothing in the intro.
export default function Narrator() {
  const phase = useApp((s) => s.phase);
  const selected = useApp((s) => s.selected);
  const advance = useApp((s) => s.advance);
  const setPhase = useApp((s) => s.setPhase);
  const story = useMapStore((s) => s.story);
  const resetMap = useResetMap();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const setMapInteractive = useSetMapInteractive();

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
      {!hidden ? (
        <div className="flex flex-col gap-3 mt-2">
          {phase === "intro" && (
            <>
              <p>
                Use this tool to see how far you can get with{" "}
                <strong>$3</strong> on a Citi Bike E-bike with a membership.
              </p>
              <p>
                To get started, find a station on the map or use the search bar.
              </p>
            </>
          )}
          {phase === "selected" && selected && (
            <>
              <p>
                How far can <strong>$3</strong> get you today? Use the button
                below to show you how far you can go — about 11 minutes of
                riding at $0.27 per minute.
              </p>
              <div className="flex gap-2">
                <button
                  className={BTN}
                  disabled={busy}
                  onClick={() => play("near")}
                >
                  Travel from {selected.name}
                </button>
                <button
                  className={BTN_ALT}
                  disabled={busy}
                  onClick={() => resetMap()}
                >
                  Back
                </button>
              </div>
            </>
          )}

          {phase === "near" && (
            <>
              <p>
                That's not very far at all — does that get you to work, to your
                friends' apartments, or even to Bushwick's 3 Dollar Bill?
              </p>
              <p>
                Next, use the button below to see how far you could get for the
                same price if we <strong>capped the fares at $3</strong> for a
                45-minute ride.
              </p>
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
                  onClick={() => play("far")}
                >
                  Cap the fares
                </button>
              </div>
            </>
          )}

          {phase === "far" && (
            <>
              <p>This is how far you could ride.</p>
              <p>
                That's a huge difference in how far you can get for the same
                price!
              </p>
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
          <button
            className="w-full flex justify-center md:hidden"
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
        </div>
      ) : (
        <button
          className="w-full flex justify-center md:hidden"
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

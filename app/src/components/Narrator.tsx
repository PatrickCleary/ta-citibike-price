import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { useMapStore } from "../lib/mapStore";
import { useResetMap } from "../lib/mapControl";
import NarrationBlock from "./NarrationBlock";

const BTN =
  "pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:cursor-default disabled:bg-gray-300 disabled:pointer-events-none";

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

  // Gate the controls for the duration of the selection flyTo (see mapControl)
  // so a draw-out can't start before the camera settles on the origin.
  useEffect(() => {
    if (!selected) return;
    setBusy(true);
    const id = setTimeout(() => setBusy(false), 2000);
    return () => clearTimeout(id);
  }, [selected?.id]);

  if (phase === "intro" || !selected) return null;

  // Play a draw-out step, then advance to the next step once it settles.
  const play = (which: "near" | "far") => {
    if (!story) return;
    setBusy(true);
    const done = () => {
      setBusy(false);
      advance();
    };
    if (which === "near") story.playNear(done);
    else story.playFar(done);
  };

  return (
    <div className="fixed inset-x-0 bottom-8 flex flex-col items-center gap-4 px-4">
      <NarrationBlock>
        <div className="pointer-events-auto flex flex-col items-center gap-1">
          {phase === "selected" && (
            <>
              <h2 className="text-2xl font-bold">{selected.name}</h2>
              <p>How far can $3 get you today? Every trip 11 minutes or less.</p>
              <button
                className={BTN}
                disabled={busy}
                onClick={() => play("near")}
              >
                Show me
              </button>
            </>
          )}

          {phase === "near" && (
            <>
              <p>Now imagine a subsidy for every trip under 45 minutes.</p>
              <button
                className={BTN}
                disabled={busy}
                onClick={() => play("far")}
              >
                Show me
              </button>
            </>
          )}

          {phase === "far" && (
            <>
              <p>Here's how far $3 could take you.</p>
              <button className={BTN} disabled={busy} onClick={() => advance()}>
                Next
              </button>
            </>
          )}

          {phase === "final" && (
            <>
              <h2 className="text-2xl font-bold">Help make it happen.</h2>
              <p>Tell the TA you support a 45-minute subsidized ride.</p>
              <div className="flex gap-2">
                <button
                  className={BTN}
                  onClick={() => setPhase("selected")}
                >
                  Replay
                </button>
                <button className={BTN} onClick={() => resetMap()}>
                  Pick another station
                </button>
              </div>
            </>
          )}
        </div>
      </NarrationBlock>
    </div>
  );
}

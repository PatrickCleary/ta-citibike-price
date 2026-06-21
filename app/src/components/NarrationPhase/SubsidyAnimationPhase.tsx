import { useResetMap } from "../../lib/mapControl";
import { useApp } from "../../lib/store";
import { useMapStore } from "../../lib/mapStore";
import { useState } from "react";

export default function SelectedPhase() {
  const { selected, setPhase } = useApp();
  const resetMap = useResetMap();
  const [isAnimating, setIsAnimating] = useState(false);
  const story = useMapStore((s) => s.story);
  if (!selected) return null;
  return (
    <div className="selected-phase">
      <h2 className="font-bold text-2xl">{selected.name}</h2> 
      <p>How far can $3 get you with a subsidy for trips under 45 min?</p>
      <button
        onClick={() => {
          setIsAnimating(true);
          // Duration is derived from the routes (constant bike speed), so advance
          // when the draw-out actually finishes rather than after a fixed timer.
          story?.playStep("all", () => setPhase("show_both"));
        }}
        className="pointer-events-auto mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        disabled={isAnimating}
      >
        play
      </button>
    </div>
  );
}

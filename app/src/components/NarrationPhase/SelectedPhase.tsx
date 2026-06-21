import { useResetMap } from "../../lib/mapControl";
import { useApp } from "../../lib/store";
import { useMapStore } from "../../lib/mapStore";
import { useEffect, useState } from "react";

export default function SelectedPhase() {
  const { selected, setPhase } = useApp();
  const resetMap = useResetMap();
  const [isAnimating, setIsAnimating] = useState(true);
  const story = useMapStore((s) => s.story);

  useEffect(() => {
    setTimeout(() => setIsAnimating(false), 2000); // re-enable buttons after zoom in to station
  }, []);
  if (!selected) return null;
  return (
    <div className="selected-phase">
      <h2 className="font-bold text-2xl">{selected.name}</h2>
      <p>How far can $3 get you today? This is every trip that takes 11 minutes or less.</p>

      <button
        onClick={() => {
          console.log("here");
          resetMap();
        }}
        disabled={isAnimating}
        className={
          isAnimating
            ? "bg-gray-300 pointer-events-none pr-2  mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            : "pointer-events-auto pr-2  mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        }
      >
        Select a different station
      </button>
      <button
        onClick={() => {
          setIsAnimating(true);
          // Duration is derived from the routes (constant bike speed), so advance
          // when the draw-out actually finishes rather than after a fixed timer.
          story?.playStep("near", () => setPhase("fade_near"));
        }}
        className={
          isAnimating
            ? "bg-gray-300 pointer-events-none pr-2  mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            : "pointer-events-auto pr-2  mt-2 inline-flex items-center px-4 py-2 cursor-pointer border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        }
        disabled={isAnimating}
      >
        play
      </button>
    </div>
  );
}

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp, type Phase } from "../lib/store";

// The story's narrative beats, centred over the map. Separate from the
// top-left card (station name + legends) and the bottom bar (controls), so the
// copy reads as the moment's headline rather than a caption.
const COPY: Partial<Record<Phase, ReactNode>> = {
  reflect: (
    <>
      <p>This is how far a $3 ride on a Citi Bike can take you currently.</p>
      <p>
        That’s not very far at all — does that get you to work, to your
        friends’ apartments?
      </p>
    </>
  ),
  subsidy: (
    <p>
      Now, if New York subsidized Citi Bike — like it subsidizes every bus,
      train, and ferry — three dollars could get you a 45-minute ride.
    </p>
  ),
  compare: (
    <>
      <p>This is how far you could ride.</p>
      <p>That's a huge difference in how far you can get for the same price!</p>
    </>
  ),
  final: (
    <>
      <p>
        Placeholder for TA copy about the campaign and links to resources, etc.
      </p>
      {/* The card is pointer-events-none so clicks reach the map; the CTA opts
          back in. */}
      <a
        href="https://act.transalt.org/a/3citibike"
        target="_blank"
        rel="noopener noreferrer"
        className="pointer-events-auto mt-2 cursor-pointer self-center rounded-full bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Take action
      </a>
    </>
  ),
};

export default function StoryCopy() {
  const phase = useApp((s) => s.phase);
  const copy = COPY[phase];
  return (
    <AnimatePresence mode="wait">
      {copy && (
        <motion.div
          key={phase}
          className="pointer-events-none fixed inset-0 flex items-center justify-center p-6"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
        >
          <div className="flex max-w-xl flex-col gap-3 rounded-2xl bg-white/90 px-8 py-6 text-center text-lg leading-relaxed text-gray-900 shadow-xl backdrop-blur md:text-xl">
            {copy}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

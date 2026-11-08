import { useMemo, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useApp, type Phase } from "../lib/store";
import { useRoutes, useWalkshed } from "../lib/queries";
import { landmarkReach } from "../lib/landmarkReach";
import type { Landmark } from "../data/landmarks";

// The story's narrative beats, centred over the map. Separate from the
// top-left card (station name + legends) and the bottom bar (controls), so the
// copy reads as the moment's headline rather than a caption.
const COPY: Partial<Record<Phase, ReactNode>> = {
  reflect: <ReflectCopy />,
  subsidy: (
    <p>
      Now, if New York subsidized Citi Bike — like it subsidizes every bus,
      train, and ferry — three dollars could get you a 45-minute ride.
    </p>
  ),
  compare: <CompareCopy />,
  final: (
    <>
      <p>
        A 45-minute Citi Bike ride shouldn’t cost more than $3 — and we’re bringing Citi Bike riders together to form the City Bike Riders Union, calling for public subsidies and efficiency improvements to bring the price down. Learn more and join our movement.
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

// The reflect step grounds the shed in places: the farthest landmarks it reaches
// and the nearest it misses (landmarkReach). Both come from data that's already
// loaded for the map — the pick's walkshed and its routes file (for the origin)
// — so there's nothing extra to fetch. Until they're in, or when a pick has no
// shed, the sentence is simply left out.
function ReflectCopy() {
  const selected = useApp((s) => s.selected);
  const walkshed = useWalkshed(selected?.id ?? null);
  const routes = useRoutes(selected?.id ?? null);
  const origin = routes.data?.origin;
  const shed = walkshed.data;
  const reach = useMemo(
    () => (shed && origin ? landmarkReach(shed, 11, origin) : null),
    [shed, origin],
  );
  const can = reach?.reachable ?? [];
  const cant = reach?.unreachable ?? [];
  return (
    <>
      <p>This is how far a $3 ride on a Citi Bike can take you currently.</p>
      {(can.length > 0 || cant.length > 0) && (
        <p>
          {can.length > 0 && cant.length > 0 ? (
            <>
              You can get to <Places list={can} />, but not{" "}
              <Places list={cant} join="or" />.
            </>
          ) : can.length > 0 ? (
            <>
              You can get to <Places list={can} />.
            </>
          ) : (
            <>
              You can’t even get to <Places list={cant} join="or" />.
            </>
          )}
        </p>
      )}
      
    </>
  );
}

// The compare step does the same for the ≤45-minute shed, but only with the
// iconic (tier 1) landmarks, farthest first — the places that make the
// subsidized ride feel like a different city.
function CompareCopy() {
  const selected = useApp((s) => s.selected);
  const walkshed = useWalkshed(selected?.id ?? null);
  const routes = useRoutes(selected?.id ?? null);
  const origin = routes.data?.origin;
  const shed = walkshed.data;
  const iconic = useMemo(
    () =>
      shed && origin
        ? landmarkReach(shed, 45, origin, { only: (l) => l.tier === 1 }).reachable
        : [],
    [shed, origin],
  );
  return (
    <>
      <p>This is how far you could ride.</p>
      {iconic.length > 0 && (
        <p>
          Now you can get to <Places list={iconic} />.
        </p>
      )}
      <p>That's a huge difference in how far you can get for the same price!</p>
    </>
  );
}

// "A, B and C" / "A, B or C" — each a Place.
function Places({ list, join = "and" }: { list: Landmark[]; join?: "and" | "or" }) {
  return (
    <>
      {list.map((l, i) => (
        <span key={l.id}>
          {i > 0 && (i === list.length - 1 ? ` ${join} ` : ", ")}
          <Place l={l} />
        </span>
      ))}
    </>
  );
}

// A landmark named inline, with its map emoji so the sentence and the label on
// the map read as the same thing.
function Place({ l }: { l: Landmark }) {
  return (
    <span className="font-semibold whitespace-nowrap">
      {l.emoji && (
        <span aria-hidden="true" className="mr-1">
          {l.emoji}
        </span>
      )}
      {l.name}
    </span>
  );
}

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

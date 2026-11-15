import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Play } from "lucide-react";
import { useApp, useHighlight } from "../lib/store";
import { useMapStore } from "../lib/mapStore";
import { useRoutes, useWalkshed } from "../lib/queries";
import { landmarkReach } from "../lib/landmarkReach";
import { walkshedBounds } from "../lib/walksheds";
import { useIsMobile } from "../lib/useIsMobile";
import { LINE } from "./StoryOverlay";
import { Legend } from "./Legend";
import { ReflectCopy, SUBSIDY_COPY } from "./StoryCopy";

// The reflect step as narration beside the map rather than over it: a card in
// the left column on desktop, a sheet up from the bottom on a phone. It opens
// with the near draw-out's count (the map key), then the copy, then the one
// way on: Play, for the far draw-out.
//
// On arrival the camera re-frames the near shed and the places the copy names,
// padded clear of where the panel will sit, and the panel slides into the room
// that clears. Those places are picked out on the map (useHighlight →
// Landmarks) so the words and the picture land together.

// Desktop card: clear of the logo button on the left.
const CARD_LEFT = 64;
const CARD_W = 420;
const FIT_MS = 1200;
// The panel follows the camera in rather than racing it.
const ENTER_DELAY_S = 0.5;

export default function ReflectPanel({ onPlay }: { onPlay: () => void }) {
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const selected = useApp((s) => s.selected);
  const walkshed = useWalkshed(selected?.id ?? null);
  const routes = useRoutes(selected?.id ?? null);
  const origin = routes.data?.origin;
  const shed = walkshed.data;
  // Same call ReflectCopy makes, so the map highlights exactly what it names.
  const reach = useMemo(
    () => (shed && origin ? landmarkReach(shed, 11, origin) : null),
    [shed, origin],
  );

  // Pick the named places out on the map while the panel is up.
  useEffect(() => {
    if (!reach) return;
    const { setHighlight } = useHighlight.getState();
    setHighlight(
      reach.reachable.map((l) => l.id),
      reach.unreachable.map((l) => l.id),
    );
    return () => setHighlight([], []);
  }, [reach]);

  // Frame the near shed and every named place, padded clear of the panel. The
  // panel is laid out (if not yet visible) by now, so its height is real.
  useEffect(() => {
    const map = useMapStore.getState().map;
    if (!map || !shed || !reach) return;
    const box = walkshedBounds(shed, [11]);
    if (!box) return;
    let [[w, s], [e, n]] = box;
    for (const l of [...reach.reachable, ...reach.unreachable]) {
      w = Math.min(w, l.lon);
      e = Math.max(e, l.lon);
      s = Math.min(s, l.lat);
      n = Math.max(n, l.lat);
    }
    const panelH = ref.current?.offsetHeight ?? 0;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        // Labels run right from their point, so leave extra room on the right.
        padding: isMobile
          ? { top: 80, bottom: panelH + 24, left: 24, right: 140 }
          : { top: 48, bottom: 72, left: CARD_LEFT + CARD_W + 48, right: 160 },
        duration: FIT_MS,
        maxZoom: 15,
      },
    );
  }, [shed, reach, isMobile]);

  const away = isMobile ? { y: 40, opacity: 0 } : { x: -24, opacity: 0 };
  return (
    <motion.div
      ref={ref}
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-10 max-h-[65vh] overflow-y-auto rounded-t-2xl bg-white/95 px-5 pt-4 pb-6 shadow-[0_-8px_30px_rgba(0,0,0,0.12)] backdrop-blur md:inset-x-auto md:top-4 md:bottom-auto md:max-h-[calc(100vh-2rem)] md:rounded-2xl md:px-7 md:pt-5 md:pb-6 md:shadow-xl"
      style={isMobile ? undefined : { left: CARD_LEFT, width: CARD_W }}
      initial={away}
      animate={{
        x: 0,
        y: 0,
        opacity: 1,
        transition: {
          type: "spring",
          stiffness: 260,
          damping: 30,
          delay: ENTER_DELAY_S,
        },
      }}
      exit={{ ...away, transition: { duration: 0.2 } }}
    >
      <motion.div
        className="flex flex-col gap-4"
        initial="hidden"
        animate="shown"
        variants={{
          shown: {
            transition: {
              staggerChildren: 0.12,
              delayChildren: ENTER_DELAY_S + 0.1,
            },
          },
        }}
      >
        {/* The near draw-out's map key: how many docks $3 reaches today, and
            the shading for the walk from them. */}
        <motion.div variants={LINE} className="border-b border-gray-200 pb-3">
          <Legend steps={["near"]} />
        </motion.div>
        <motion.div
          variants={LINE}
          className="flex flex-col gap-2 text-lg leading-snug font-semibold text-gray-900 md:text-xl"
        >
          <ReflectCopy />
        </motion.div>
        <motion.div
          variants={LINE}
          className="text-base leading-relaxed text-gray-700 md:text-lg"
        >
          {SUBSIDY_COPY}
        </motion.div>
        <motion.button
          variants={LINE}
          type="button"
          autoFocus
          className="mt-1 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-blue-600 pr-6 pl-5 text-base font-semibold text-white shadow-lg transition-[background-color,scale] duration-150 hover:scale-[1.03] hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 active:scale-95 md:w-auto md:self-start"
          onClick={onPlay}
        >
          <Play size={18} fill="currentColor" />
          Play
        </motion.button>
      </motion.div>
    </motion.div>
  );
}

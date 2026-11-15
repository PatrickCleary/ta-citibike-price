import type { ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { Play } from "lucide-react";

// The story's full-screen beats: a light wash over the map with one column of
// copy on top and one obvious action at the bottom of it. The wash fades on its
// own; the column's direct children rise in one after another, so each should
// be a motion element using LINE (wrap anything that isn't in a motion.div).
// Mount inside an AnimatePresence so it fades back out when the step moves on.

export const LINE: Variants = {
  hidden: { opacity: 0, y: 12 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

export default function StoryOverlay({
  placement = "center",
  children,
}: {
  /** "top" keeps the column in the upper part of the screen, clear of
   *  whatever the map is showing in the middle (the picked dock). */
  placement?: "top" | "center";
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`pointer-events-none fixed inset-0 z-10 flex justify-center overflow-y-auto bg-white/50 px-4 ${
        placement === "top"
          ? "items-start pt-[12vh] md:pt-[16vh]"
          : "items-center py-8"
      }`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        className="flex w-full max-w-2xl flex-col items-center gap-4 text-center"
        initial="hidden"
        animate="shown"
        exit="hidden"
        variants={{ shown: { transition: { staggerChildren: 0.1 } } }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

// The overlay's one obvious action: start the step's draw-out. Takes focus so
// Enter plays it.
export function OverlayPlayButton({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      variants={LINE}
      type="button"
      autoFocus
      className="pointer-events-auto mt-6 inline-flex h-14 cursor-pointer items-center justify-center gap-2.5 rounded-full bg-blue-600 pr-8 pl-7 text-lg font-semibold text-white shadow-xl transition-[background-color,scale] duration-150 hover:scale-[1.03] hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 active:scale-95"
      onClick={onClick}
    >
      <Play size={22} fill="currentColor" />
      Play
    </motion.button>
  );
}

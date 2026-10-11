import type { ReactNode } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";

// First-load splash over a dimmed map: the pitch, plus two ways in — the
// search bar (passed in, so it's the same one the intro card uses) or picking
// straight from the map, which just dismisses this.
export default function IntroOverlay({
  search,
  onDismiss,
}: {
  search: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-10 flex items-center justify-center overflow-y-auto bg-white/75 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Same spot as the orange dot that reopens this, so it toggles in place. */}
      <button
        aria-label="Close"
        className="fixed left-4 top-4 flex size-10 cursor-pointer items-center justify-center rounded-full bg-white text-gray-700 shadow-lg hover:bg-gray-50 hover:text-gray-900"
        onClick={onDismiss}
      >
        <X size={20} />
      </button>
      <div className="flex w-full max-w-xl flex-col gap-5 text-gray-800">
        <img
          src="/ta_logo_RGB_REFRESH_transparent.webp"
          alt="Transportation Alternatives"
          className="h-10 w-auto self-start md:h-12"
        />
        <h1 className="text-3xl font-semibold text-gray-900 md:text-4xl">
          How far does $3 go in New York City?
        </h1>
        <p className="text-base leading-relaxed md:text-lg">
          Citi Bike is too expensive. In just five years, the price to ride an
          e-bike has tripled. $3 is the price of a subway or bus fare, but it
          will only buy a Citi Bike member <strong>11 minutes</strong> of
          riding. Choose a Citi
          Bike station to see how far $3.00 will get you in New York City.
        </p>
        <div className="flex flex-col gap-3">
          {search}
          <button
            className="cursor-pointer self-center text-sm text-gray-600 underline underline-offset-2 hover:text-gray-900"
            onClick={onDismiss}
          >
            Or find one on the map
          </button>
        </div>
      </div>
    </motion.div>
  );
}

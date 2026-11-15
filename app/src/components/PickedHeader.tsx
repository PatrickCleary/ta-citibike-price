import { motion } from "motion/react";
import { BRAND_ORANGE } from "../lib/constants";
import StoryOverlay, { LINE, OverlayPlayButton } from "./StoryOverlay";

// The first story step, once a dock is picked and the camera has landed on it
// (Narrator holds it back until then): one question, and one obvious way to
// answer it. Kept to the upper part of the screen; the selection ease lands the
// dock below centre (PICK_OFFSET) so it stays in view underneath.

// "in the Bronx"; every other borough reads bare.
const inBorough = (b: string) => (b === "Bronx" ? "the Bronx" : b);

export default function PickedHeader({
  name,
  borough,
  onPlay,
  onChangeStation,
}: {
  name: string;
  borough: string | null;
  onPlay: () => void;
  onChangeStation: () => void;
}) {
  return (
    <StoryOverlay placement="top">
      <motion.h1
        variants={LINE}
        className="text-3xl font-semibold leading-tight text-balance text-gray-900 md:text-5xl"
      >
        Let’s see how far $3.00 on an electric Citi Bike will get you today
      </motion.h1>
      <motion.p variants={LINE} className="text-lg text-gray-800 md:text-2xl">
        From{" "}
        <span className="font-semibold" style={{ color: BRAND_ORANGE }}>
          {name}
        </span>
        {borough && <> in {inBorough(borough)}</>}
      </motion.p>
      <motion.button
        variants={LINE}
        type="button"
        className="pointer-events-auto -mt-2 cursor-pointer text-sm text-gray-600 underline underline-offset-2 hover:text-gray-900"
        onClick={onChangeStation}
      >
        or select a different station
      </motion.button>
      <OverlayPlayButton onClick={onPlay} />
    </StoryOverlay>
  );
}

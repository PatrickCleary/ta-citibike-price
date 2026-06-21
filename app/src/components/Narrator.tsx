import { useApp, PHASE_ORDER, type Phase } from "../lib/store";
import NarrationBlock from "./NarrationBlock";
import SelectedPhase from "./NarrationPhase/SelectedPhase";
import SubsidyAnimationPhase from "./NarrationPhase/SubsidyAnimationPhase";

// Caption (and optional sub-line) shown for each navigable story phase. Phases
// absent from this map render nothing — e.g. `selecting` (the intro prompt is
// shown elsewhere) and `reset`.
const CONTENT: Partial<Record<Phase, { title: string; body?: string }>> = {
  show_near: { title: "How far does a $3 Citi Bike ride take you today?" },
  fade_near: { title: "We want to subsidize it to 45 minutes." },
  show_far: { title: "Here's how far $3 could take you." },
  show_both: { title: "Here's how far $3 could take you." },
  cta: {
    title: "Help make it happen.",
    body: "Tell the TA you support a 45-minute subsidized ride.",
  },
};

// Floating caption + prev/next controls, driven entirely by the store's phase.
// Renders nothing outside the story (no caption for the current phase).
export default function Narrator() {
  const phase = useApp((s) => s.phase);
  const advance = useApp((s) => s.advance);
  const back = useApp((s) => s.back);

  const content = CONTENT[phase];
  if (!content) return null;

  const i = (PHASE_ORDER as readonly Phase[]).indexOf(phase);
  const isFirst = i === 0;
  const isLast = i === PHASE_ORDER.length - 1;

  const getPhaseContent = () => {
    if (phase === "show_near") {
      return <SelectedPhase />;
    } if (phase === "fade_near") {
      return <SubsidyAnimationPhase />;
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-8 flex flex-col items-center gap-4 px-4">
      <NarrationBlock>{getPhaseContent() || null}</NarrationBlock>
    </div>
  );
}

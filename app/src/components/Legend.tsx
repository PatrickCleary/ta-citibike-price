import { Check } from "lucide-react";
import { useApp, type Layers, type StepKey } from "../lib/store";
import { useRoutes } from "../lib/queries";
import { COLOR_ALL, COLOR_NEAR } from "../lib/tripLines";
import { TIERS } from "../lib/walksheds";

// Map key for a draw-out step: how many docks the tier reaches, in the colour
// its trip dots and walkshed fill are painted (orange for near; the far step
// recolours everything indigo), then one quiet line for the shaded walksheds.
// Each label has a short form for phones, where the card is ~260px wide and
// the full sentence wraps the count onto two lines.
const LEGEND_LABELS: Record<StepKey, { full: string; short: string }> = {
  near: {
    full: "stations within a $3 fare today (11 min)",
    short: "stations, $3 today (11 min)",
  },
  far: {
    full: "stations within a $3 capped fare (45 min)",
    short: "stations, $3 capped (45 min)",
  },
};
const TIER_KEY: Record<StepKey, "11" | "45"> = { near: "11", far: "45" };

export const rgbOf = (step: StepKey) => (step === "near" ? COLOR_NEAR : COLOR_ALL);

// One row per tier. On the far step the rows ARE the tier toggle: `layers` +
// `onToggle` make each row a button with a check indicator, dimmed while off,
// and the last row left on can't be switched off. Without them (the near
// step) the rows are static, with the same indicator always checked so the
// two steps read alike.
export function Legend({
  steps,
  layers,
  onToggle,
}: {
  steps: StepKey[];
  layers?: Layers;
  onToggle?: (step: StepKey) => void;
}) {
  const selected = useApp((s) => s.selected);
  // Same query Map.tsx fires on pick, so this is a cache hit by the time the
  // near step shows. The 45 set is a superset of 11, so each is a plain count.
  const routes = useRoutes(selected?.id ?? null).data;
  const isOn = (step: StepKey) => (layers ? layers[step] : true);
  const shown = steps.filter(isOn);
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="-mx-1.5 flex flex-col text-xs text-gray-800 md:text-sm">
        {steps.map((step) => {
          const [r, g, b] = rgbOf(step);
          const rgb = `rgb(${r},${g},${b})`;
          const on = isOn(step);
          const last = on && shown.length === 1;
          const count = routes
            ? Object.keys(routes[TIER_KEY[step]]).length
            : null;
          const row = (
            <>
              <span
                aria-hidden
                className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  on ? "text-white" : "border-gray-300 bg-transparent"
                }`}
                style={on ? { background: rgb, borderColor: rgb } : undefined}
              >
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <span
                className={`text-lg font-semibold tabular-nums transition-colors md:text-xl ${
                  on ? "" : "text-gray-400"
                }`}
                style={on ? { color: rgb } : undefined}
              >
                {count == null ? "—" : count.toLocaleString()}
              </span>
              <span className={on ? "" : "text-gray-400"}>
                <span className="md:hidden">{LEGEND_LABELS[step].short}</span>
                <span className="hidden md:inline">
                  {LEGEND_LABELS[step].full}
                </span>
              </span>
            </>
          );
          return (
            <li key={step}>
              {onToggle ? (
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={last}
                  title={last ? "At least one layer stays on" : undefined}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left whitespace-nowrap transition-colors hover:bg-black/5 disabled:cursor-default disabled:hover:bg-transparent md:gap-2"
                  onClick={() => onToggle(step)}
                >
                  {row}
                </button>
              ) : (
                <span className="flex items-center gap-1.5 px-1.5 py-0.5 whitespace-nowrap md:gap-2">
                  {row}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="flex shrink-0 gap-1">
          {shown.map((step) => {
            const [r, g, b] = rgbOf(step);
            return (
              <span
                key={step}
                className="size-3 rounded-sm border"
                style={{
                  background: `rgba(${r},${g},${b},${TIERS[step].fill})`,
                  borderColor: TIERS[step].color,
                }}
              />
            );
          })}
        </span>
        5-minute walk from a reachable station
      </p>
    </div>
  );
}

// The top-left card's content on the far step: its map key (and tier toggle).
// Map.tsx hides the card on every other step; the near step's key is in the
// reflect panel (ReflectPanel).
export function StepLegend() {
  const phase = useApp((s) => s.phase);
  const layers = useApp((s) => s.layers);
  const setLayers = useApp((s) => s.setLayers);
  const exploring = useApp((s) => s.exploring);
  if (phase === "far") {
    if (exploring) {
      return (
        <p className="text-sm text-gray-800">
          Tap any station on the map to see how far it gets you.
        </p>
      );
    }
    return (
      <Legend
        steps={["near", "far"]}
        layers={layers}
        onToggle={(k) => setLayers({ ...layers, [k]: !layers[k] })}
      />
    );
  }
  return null;
}

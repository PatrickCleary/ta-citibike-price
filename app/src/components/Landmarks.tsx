// Orientation labels: an emoji and a name at each curated landmark
// (data/landmarks.ts), so someone watching the trip lines ride out can tell
// Midtown from Astoria without street labels (the basemap has none).
//
// They're up throughout the story, but not while a dock is being picked — the
// intro's city-wide field, and the far step's "another station" explore mode —
// where the docks are the point and labels over them would only get in the way.
//
// Labels are collision-culled per frame (see BY_PRIORITY), so the wide far-step
// frame shows as many as fit, iconic ones first, and the rest arrive as the
// camera closes in.
//
// Same DOM-marker pattern as StationBubble: Marker keeps each element positioned
// as the camera moves, and only a change to the SET in view re-renders. A
// landmark mounts when it enters the viewport (or wins its space back), so as
// the camera moves, new ones fade in just inside the edge, each a beat late.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import { LANDMARKS, type Landmark } from "../data/landmarks";
import { useMapStore } from "../lib/mapStore";
import { useApp } from "../lib/store";

// Tier never hides a landmark on its own — every one shows wherever there is
// room. Tier only decides who wins when two labels would overlap: tier 1 first.
// Labels claim screen space greedily. Each gets two tries: the full label (icon
// + name), then, if that would overlap something already placed, the icon alone.
// Only when even the icon has no room does it hide, so a crowded frame degrades
// to a scatter of emoji before it loses landmarks.
//
// Order matters, and it is NOT simply by tier: landmarks already on the map go
// first (by tier among themselves), newcomers after. Re-solving from scratch
// every frame let a neighbour drifting into the same pixels bump a label that
// was already up, which then came back a few frames later — on a zoom the whole
// layer blinked. Incumbents keep their space until they collide with each
// other, and a dropped name needs a little extra room (PROMOTE_MARGIN) before
// it returns, so pills don't flicker at the threshold. The box is
// an estimate of the marker's rendered size (Landmarks are never measured — that
// would mean mounting them first), sized from the CSS below. Docks, trip lines
// and walksheds are not considered; labels sit over them freely.
//
// Layout: one pill. Its left end is a solid white disc holding the emoji (or,
// for a name-only landmark, a small dot), centred on the point itself; the name
// runs out of the disc to the right on a translucent segment of the same height.
const ICON_W = 22; // the disc; also the pill's height
const DOT = 8;
const GAP = 0;
const PILL_H = ICON_W;
const LABEL_MARGIN = 6;
const PROMOTE_MARGIN = 10; // extra clearance to restore a name once dropped
// The name segment's width beyond the disc: 11px text at ~6px a glyph plus
// 5+8px padding.
const pillWidth = (l: Landmark) => 13 + 6 * l.name.length;

// Priority among landmarks of equal standing: tier, then the data file's order
// (roughly south→north per borough), so ties resolve the same way every frame.
const BY_PRIORITY = [...LANDMARKS].sort((a, b) => a.tier - b.tier);

// How long a landmark waits after entering the view before it fades in.
const APPEAR_DELAY_MS = 450;
const APPEAR_MS = 350;

export default function Landmarks() {
  const map = useMapStore((s) => s.map);
  // Picking a dock: the intro, or exploring on the far step.
  const picking = useApp((s) => s.phase === "intro" || s.exploring);
  const placed = useVisibleLandmarks(picking ? null : map);

  const byId = useMemo(
    () => new globalThis.Map(LANDMARKS.map((l) => [l.id, l])),
    [],
  );

  if (!map) return null;
  return (
    <>
      {placed.map(({ id, compact }) => {
        const landmark = byId.get(id);
        return landmark ? (
          <LandmarkMarker
            key={id}
            map={map}
            landmark={landmark}
            compact={compact}
          />
        ) : null;
      })}
    </>
  );
}

// A placed landmark: `compact` means icon only, the name having lost its space.
type Placed = { id: string; compact: boolean };

type Box = [number, number, number, number]; // x0, y0, x1, y1 in canvas px
const overlaps = (a: Box, b: Box) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// The landmarks inside the viewport that win their screen space, and how much
// of each (full label or icon only). A null map parks the layer (nothing shown).
function useVisibleLandmarks(map: maplibregl.Map | null): Placed[] {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const keyRef = useRef("");
  // Last frame's result, for incumbent priority: id → compact.
  const prevRef = useRef<globalThis.Map<string, boolean>>(new globalThis.Map());

  useEffect(() => {
    if (!map) {
      keyRef.current = "";
      prevRef.current = new globalThis.Map();
      setPlaced([]);
      return;
    }
    let raf: number | null = null;

    const recompute = () => {
      raf = null;
      const prev = prevRef.current;
      const next: Placed[] = [];
      const bounds = map.getBounds();
      const taken: Box[] = [];
      // Incumbents first (by tier among themselves), then newcomers by tier.
      const order = [
        ...BY_PRIORITY.filter((l) => prev.has(l.id)),
        ...BY_PRIORITY.filter((l) => !prev.has(l.id)),
      ];
      for (const l of order) {
        if (!bounds.contains([l.lon, l.lat])) continue;
        // The icon is centred on the point; the pill runs right from there.
        const { x, y } = map.project([l.lon, l.lat]);
        const y0 = y - PILL_H / 2 - LABEL_MARGIN;
        const y1 = y + PILL_H / 2 + LABEL_MARGIN;
        const x0 = x - ICON_W / 2 - LABEL_MARGIN;
        const iconBox: Box = [x0, y0, x + ICON_W / 2 + LABEL_MARGIN, y1];
        const fullBox: Box = [x0, y0, iconBox[2] + GAP + pillWidth(l), y1];
        // A name that was dropped (or never shown) needs clearance to spare
        // before it goes up; one already showing only has to not collide.
        const wasFull = prev.get(l.id) === false;
        const m = wasFull ? 0 : PROMOTE_MARGIN;
        const wantBox: Box = [fullBox[0] - m, fullBox[1] - m, fullBox[2] + m, fullBox[3] + m];
        if (!taken.some((b) => overlaps(wantBox, b))) {
          taken.push(fullBox);
          next.push({ id: l.id, compact: false });
        } else if (!taken.some((b) => overlaps(iconBox, b))) {
          taken.push(iconBox);
          next.push({ id: l.id, compact: true });
        }
      }
      prevRef.current = new globalThis.Map(next.map((p) => [p.id, p.compact]));
      // Diff the result so a steady pan doesn't re-render every marker per frame.
      const key = next.map((p) => (p.compact ? p.id + "~" : p.id)).join(",");
      if (key === keyRef.current) return;
      keyRef.current = key;
      setPlaced(next);
    };
    const schedule = () => {
      if (raf == null) raf = requestAnimationFrame(recompute);
    };

    recompute();
    map.on("move", schedule);
    map.on("zoom", schedule);
    return () => {
      map.off("move", schedule);
      map.off("zoom", schedule);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [map]);

  return placed;
}

function LandmarkMarker({
  map,
  landmark,
  compact,
}: {
  map: maplibregl.Map;
  landmark: Landmark;
  compact: boolean;
}) {
  const el = useMemo(() => document.createElement("div"), []);

  useEffect(() => {
    // The element starts at the icon's left edge; shifting it back by half the
    // icon slot puts the emoji's centre on the point.
    const marker = new maplibregl.Marker({
      element: el,
      anchor: "left",
      offset: [-ICON_W / 2, 0],
    })
      .setLngLat([landmark.lon, landmark.lat])
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [map, el, landmark.lon, landmark.lat]);

  // Under the station bubbles (zIndex 0/1): the story's own labels win.
  el.style.zIndex = "0";

  return createPortal(
    <div
      className="pointer-events-none flex items-center"
      style={{
        gap: GAP,
        // One shadow for the whole pill: a filter follows the combined
        // silhouette of disc + name, where a box-shadow on each would double up
        // (and the segment's would peek out under the disc).
        filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.18))",
        // `backwards` holds the from-frame (invisible) through the delay.
        animation: `landmark-in ${APPEAR_MS}ms ease-out ${APPEAR_DELAY_MS}ms backwards`,
      }}
    >
      {/* The disc on the spot: the emoji itself, or a dot for a name-only
          landmark. Opaque, and layered over the name segment's start so the
          two read as one pill. */}
      <span
        className="relative z-10 flex shrink-0 items-center justify-center rounded-full bg-white text-sm leading-none"
        style={{ width: ICON_W, height: ICON_W }}
        aria-hidden="true"
      >
        {landmark.emoji || (
          <span
            className="rounded-full bg-neutral-500"
            style={{ width: DOT, height: DOT }}
          />
        )}
      </span>
      {/* The name, unless it lost its space to a neighbour (compact). It fades
          in on its own when the camera makes room again. Tucks under the disc
          by half its width so the pill has no seam. */}
      {!compact && (
        <span
          className="flex items-center rounded-r-full bg-white/60 pr-2 text-[11px] leading-none font-normal whitespace-nowrap text-neutral-500"
          style={{
            height: PILL_H,
            marginLeft: -ICON_W / 2,
            paddingLeft: ICON_W / 2 + 5,
            animation: `landmark-in ${APPEAR_MS}ms ease-out backwards`,
          }}
        >
          {landmark.name}
        </span>
      )}
    </div>,
    el,
  );
}

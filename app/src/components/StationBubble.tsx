// The dock's third look: a named bubble.
//
// A dock is a dot when the field is dense, a pin once it has room, and a bubble
// once there's room for its NAME (see the cross-fade note in dockController).
// The first two are map layers; this one is DOM, because a rounded pill with an
// icon and a text label is a thing HTML is good at and a symbol layer is not.
//
// DOM is affordable here only because of the zoom gate. Bubbles are ~2400
// stations' worth of markers at zoom 13 and ~15 at zoom 17 — ZOOM_BUBBLE is set
// where both the node count and the label collisions come out survivable. The
// selected and hovered docks are exempt: they're at most two markers, so they
// get a bubble at any zoom.
//
// Marker keeps its own element positioned as the camera moves, so panning costs
// no React work — only a change to the SET of visible docks re-renders.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import maplibregl from "maplibre-gl";
import BikeIcon from "./BikeIcon";
import { BRAND_ORANGE } from "../lib/constants";
import { ZOOM_BUBBLE, type StationPoint } from "../lib/dockController";
import { useApp, useHover } from "../lib/store";
import { useMapStore } from "../lib/mapStore";
import { useSelectStation } from "../lib/mapControl";

// Fraction of the viewport to over-scan, so a bubble mounts (and plays its
// fade-in) just before its dock is panned into view rather than popping in at
// the edge.
const PAD = 0.15;

export default function StationBubbles({
  stations,
}: {
  stations: StationPoint[];
}) {
  const map = useMapStore((s) => s.map);
  const phase = useApp((s) => s.phase);
  const selected = useApp((s) => s.selected);
  const hoveredId = useHover((s) => s.hoveredId);
  const selectStation = useSelectStation();

  const byId = useMemo(
    () => new globalThis.Map(stations.map((s) => [s.id, s])),
    [stations],
  );

  const intro = phase === "intro";
  const fieldIds = useFieldStations(map, stations, intro);

  // Once a station is picked the story owns the map and DockController.isolate
  // hides every other dock — so the origin is the only bubble, at whatever zoom
  // the step's camera happens to be at.
  const shown = useMemo(() => {
    if (!intro) return selected ? [{ id: selected.id, lead: true }] : [];
    const out = fieldIds.map((id) => ({ id, lead: false }));
    if (hoveredId && !fieldIds.includes(hoveredId)) {
      out.push({ id: hoveredId, lead: true });
    }
    return out;
  }, [intro, selected, fieldIds, hoveredId]);

  if (!map) return null;
  return (
    <>
      {shown.map(({ id, lead }) => {
        const station = byId.get(id);
        if (!station) return null;
        return (
          <StationBubble
            key={id}
            map={map}
            station={station}
            lead={lead}
            // Above the gate the bubbles ARE the field — they cover the pins, so
            // they have to carry the pick that the pin layer would have.
            onSelect={intro ? () => selectStation(station) : undefined}
          />
        );
      })}
    </>
  );
}

// Ids of the docks inside the (padded) viewport, or none when the camera is
// below the gate. `enabled` false parks the hook entirely — during the story the
// field is hidden, so there's nothing to track.
function useFieldStations(
  map: maplibregl.Map | null,
  stations: StationPoint[],
  enabled: boolean,
): string[] {
  const [ids, setIds] = useState<string[]>([]);
  const keyRef = useRef("");

  useEffect(() => {
    if (!map || !enabled) {
      keyRef.current = "";
      setIds([]);
      return;
    }
    let raf: number | null = null;

    const recompute = () => {
      raf = null;
      const next: string[] = [];
      if (map.getZoom() >= ZOOM_BUBBLE) {
        const b = map.getBounds();
        const padX = (b.getEast() - b.getWest()) * PAD;
        const padY = (b.getNorth() - b.getSouth()) * PAD;
        const w = b.getWest() - padX;
        const e = b.getEast() + padX;
        const s = b.getSouth() - padY;
        const n = b.getNorth() + padY;
        for (const st of stations) {
          if (st.lon >= w && st.lon <= e && st.lat >= s && st.lat <= n) {
            next.push(st.id);
          }
        }
      }
      // A pan moves the viewport every frame but changes this SET only when a
      // dock crosses an edge. Diffing the ids here is what keeps a steady pan
      // from re-rendering every marker 60 times a second.
      const key = next.join(",");
      if (key === keyRef.current) return;
      keyRef.current = key;
      setIds(next);
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
  }, [map, stations, enabled]);

  return ids;
}

function StationBubble({
  map,
  station,
  lead,
  onSelect,
}: {
  map: maplibregl.Map;
  station: StationPoint;
  lead: boolean;
  onSelect?: () => void;
}) {
  const el = useMemo(() => document.createElement("div"), []);

  useEffect(() => {
    // The tail tip is the dock, so the bubble hangs off `bottom`.
    const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([station.lon, station.lat])
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [map, el, station.lon, station.lat]);

  // The picked/hovered dock outranks the field it sits in.
  el.style.zIndex = lead ? "1" : "0";

  return createPortal(
    <Bubble name={station.name} onSelect={onSelect} />,
    el,
  );
}

function Bubble({
  name,
  onSelect,
}: {
  name: string;
  onSelect?: () => void;
}) {
  return (
    <div
      className={`flex animate-[bubble-in_150ms_ease-out] flex-col items-center ${
        onSelect ? "cursor-pointer" : "pointer-events-none"
      }`}
      onClick={onSelect}
    >
      <div
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 shadow-md ring-1 ring-black/10"
        style={{ backgroundColor: BRAND_ORANGE }}
      >
        <BikeIcon className="h-3 w-3 shrink-0 text-white" />
        <span className="text-xs font-semibold whitespace-nowrap text-white">
          {name}
        </span>
      </div>
      {/* Tail: a CSS triangle, so it inherits nothing and costs no extra node. */}
      <div
        className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent"
        style={{ borderTopColor: BRAND_ORANGE }}
      />
    </div>
  );
}

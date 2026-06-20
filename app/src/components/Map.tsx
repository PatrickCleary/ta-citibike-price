import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import maplibregl from "maplibre-gl";
import { CONTOURS, fetchReach } from "../lib/sheds";
import {
  StationWave,
  stationPaint,
  STATIONS_SOURCE,
  STATIONS_LAYER,
  type StationPoint,
} from "../lib/stationWave";
import { TripLines, type TierState } from "../lib/tripLines";
import { fetchRoutes } from "../lib/trips";

const STADIA_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;
// Custom "Alidade Smooth, no labels" style. Its tiles/sprite are served by
// Stadia (keyless on localhost); transformRequest appends the API key in prod.
const STYLE_URL = "/data/custom_adilade_no_labels.json";

const transformRequest: maplibregl.RequestTransformFunction = (url) => {
  if (STADIA_KEY && url.includes("stadiamaps.com")) {
    return { url: `${url}${url.includes("?") ? "&" : "?"}api_key=${STADIA_KEY}` };
  }
  return { url };
};

// Station shown on load; scrolling scrubs its trips out.
const AUTO_ID = "1965202298784063998";
// Scroll track height (vh). The map is pinned; this much scroll = progress 0→1.
const SCROLL_VH = 600;
const EMPTY: Set<string> = new Set();

// Full-metro view shown during the intro, before zooming into the station.
const FULL_VIEW = { center: [-73.95, 40.71] as [number, number], zoom: 10.3 };

// Scroll-progress phase boundaries.
const INTRO_END = 0.1; // [0, 0.10)   full map + prompt
const ZOOM_END = 0.22; // [0.10, 0.22) fly into the station
const NEAR_END = 0.55; // [0.22, 0.55) ≤11-min trips draw; then 45-min to 1.0
const RING_FADE = 0.15; // fraction of the ring phase used to fade the 11-min set

// Camera: start tight on the station, zoom out to follow the trips.
const MAX_ZOOM = 18;
const MIN_ZOOM = 8.5;
const FIT_PAD_PX = 80;
const FIT_BUFFER = 1.25;

type Phase = "intro" | "zoom" | "near" | "ring";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// Zoom that fits a radius (metres) around `lat` within the map viewport.
function zoomForRadius(map: maplibregl.Map, lat: number, radiusM: number): number {
  const c = map.getCanvas();
  const avail = Math.min(c.clientWidth, c.clientHeight) / 2 - FIT_PAD_PX;
  if (!(radiusM > 0) || avail <= 0) return MAX_ZOOM;
  const mppAtZ0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
  const z = Math.log2((avail * mppAtZ0) / radiusM);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

const HIDDEN: TierState = { visible: false, progress: 0, opacity: 1 };

interface Selected {
  id: string;
  name: string;
}

interface Reach {
  near: string[];
  ring: string[];
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const waveRef = useRef<StationWave | null>(null);
  const tripsRef = useRef<TripLines | null>(null);
  const selectedRef = useRef<Selected | null>(null);
  const appliedRef = useRef(false); // selection styling currently applied?
  const phaseRef = useRef<Phase>("intro");
  const coordsRef = useRef(new globalThis.Map<string, [number, number]>()); // id → [lng, lat]
  const targetPRef = useRef(0); // scroll progress target
  const curPRef = useRef(0); // smoothed progress actually rendered
  const rafRef = useRef<number | null>(null);

  const [selected, setSelected] = useState<Selected | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [routes, setRoutes] = useState<Awaited<ReturnType<typeof fetchRoutes>>>(null);
  const [routesReady, setRoutesReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // --- one-time map setup -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: FULL_VIEW.center,
      zoom: FULL_VIEW.zoom,
      transformRequest,
    });
    mapRef.current = map;
    waveRef.current = new StationWave(map);
    tripsRef.current = new TripLines(map);
    // Fully scroll-driven: no user pan/zoom/rotate. (Clicks still select.)
    map.scrollZoom.disable();
    map.dragPan.disable();
    map.dragRotate.disable();
    map.doubleClickZoom.disable();
    map.touchZoomRotate.disable();
    map.touchPitch.disable();
    map.keyboard.disable();
    map.boxZoom.disable();

    fetch("/stations.geojson")
      .then((r) => r.json())
      .then((fc) => {
        const list: StationPoint[] = [];
        let autoName = "Station";
        for (const f of fc.features) {
          const id = f.properties?.station_id;
          const [lon, lat] = f.geometry?.coordinates ?? [];
          if (typeof id === "string" && typeof lon === "number") {
            list.push({ id, lon, lat });
            coordsRef.current.set(id, [lon, lat]);
            if (id === AUTO_ID) autoName = f.properties?.name ?? autoName;
          }
        }
        waveRef.current?.setStations(list);
        loadReach(AUTO_ID, autoName);
      })
      .catch(() => {});

    map.on("load", () => {
      map.addSource(STATIONS_SOURCE, {
        type: "geojson",
        data: "/stations.geojson",
        promoteId: "station_id",
      });
      map.addLayer({
        id: STATIONS_LAYER,
        type: "circle",
        source: STATIONS_SOURCE,
        paint: stationPaint(),
      });

      map.on("click", STATIONS_LAYER, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = f.properties?.station_id as string;
        const name = (f.properties?.name as string) ?? "Station";
        loadReach(id, name);
      });
      map.on("mouseenter", STATIONS_LAYER, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", STATIONS_LAYER, () => {
        map.getCanvas().style.cursor = "";
      });

      // Station layer now exists → re-render so deck layers sit beneath it and
      // the current scroll phase is applied.
      kick();
    });

    return () => {
      waveRef.current?.dispose();
      tripsRef.current?.dispose();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadReach(id: string, name: string) {
    setError(null);
    setSelected({ id, name });
    setReach(null);
    setRoutes(null);
    setRoutesReady(false);
    appliedRef.current = false;
    waveRef.current?.reset();
    tripsRef.current?.clear();
    fetchReach(id)
      .then((r) => {
        const near = new Set(r["11"]);
        const ring = r["45"].filter((s) => !near.has(s));
        setReach({ near: r["11"], ring });
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    fetchRoutes(id)
      .then(setRoutes)
      .catch(() => setRoutes(null))
      .finally(() => setRoutesReady(true));
  }

  // The core scroll → phase mapping: drives tiers, camera, selection + caption.
  // `p` is the (smoothed) scroll progress in [0, 1].
  const scrub = useCallback((p: number) => {
    const map = mapRef.current;
    const trips = tripsRef.current;
    const wave = waveRef.current;
    if (!map) return;

    // Centre on the selected station itself (independent of whether it's routed).
    const sel = selectedRef.current;
    const origin = sel ? coordsRef.current.get(sel.id) ?? null : null;

    const phase: Phase =
      p < INTRO_END ? "intro" : p < ZOOM_END ? "zoom" : p < NEAR_END ? "near" : "ring";

    // Once a station is selected and we've left the intro, hide every station
    // dot except the origin — filter the layer down to just that feature so the
    // origin marker stays put while the rest of the field drops away. Cleared on
    // scroll-back to intro (and when nothing is selected, so it stays pickable).
    if (map.getLayer(STATIONS_LAYER)) {
      const want = sel && phase !== "intro" ? sel.id : null;
      const cur = map.getFilter(STATIONS_LAYER) as unknown[] | undefined;
      const curId = Array.isArray(cur) ? (cur[2] as string) : null;
      if (want !== curId) {
        map.setFilter(
          STATIONS_LAYER,
          want ? ["==", ["get", "station_id"], want] : null,
        );
      }
    }

    // Selection styling: full dot field during intro, isolate the origin after.
    if (phase === "intro") {
      if (appliedRef.current) {
        wave?.reset();
        appliedRef.current = false;
      }
    } else if (!appliedRef.current && selectedRef.current && wave) {
      wave.select({
        selectedId: selectedRef.current.id,
        near: EMPTY,
        ring: EMPTY,
        showNear: true,
        showRing: true,
        hideOthers: true,
      });
      wave.start();
      appliedRef.current = true;
    }

    // Tiers.
    if (trips) {
      if (phase === "intro" || phase === "zoom") {
        trips.setTiers(HIDDEN, HIDDEN);
      } else if (phase === "near") {
        const np = clamp01((p - ZOOM_END) / (NEAR_END - ZOOM_END));
        trips.setTiers({ visible: true, progress: np, opacity: 1 }, HIDDEN);
      } else {
        const rp = clamp01((p - NEAR_END) / (1 - NEAR_END));
        const nearOpacity = lerp(1, 0.25, clamp01(rp / RING_FADE));
        trips.setTiers(
          { visible: true, progress: 1, opacity: nearOpacity },
          { visible: true, progress: rp, opacity: 1 },
        );
      }
    }

    // Camera: the station stays centred the whole time — it's a pure zoom, no
    // pan. Intro frames the metro around it, then we zoom straight in and back
    // out to follow the trips.
    if (phase === "intro") {
      map.jumpTo({ center: origin ?? FULL_VIEW.center, zoom: FULL_VIEW.zoom });
    } else if (origin && phase === "zoom") {
      const t = easeInOut(clamp01((p - INTRO_END) / (ZOOM_END - INTRO_END)));
      map.jumpTo({ center: origin, zoom: lerp(FULL_VIEW.zoom, MAX_ZOOM, t) });
    } else if (origin) {
      const radius = (trips?.getDrawnRadius() ?? 0) * FIT_BUFFER + 150;
      map.jumpTo({ center: origin, zoom: zoomForRadius(map, origin[1], radius) });
    }

    if (phaseRef.current !== phase) {
      phaseRef.current = phase;
      setPhase(phase);
    }
  }, []);

  // Smoothly ease the rendered progress toward the scroll target, so coarse
  // mouse-wheel steps still scrub fluidly. Loop runs only while catching up.
  const kick = useCallback(() => {
    if (rafRef.current != null) return;
    const tick = () => {
      const target = targetPRef.current;
      const cur = curPRef.current;
      const next = Math.abs(target - cur) < 0.0008 ? target : cur + (target - cur) * 0.18;
      curPRef.current = next;
      scrub(next);
      if (next === target) {
        rafRef.current = null;
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [scrub]);

  // Decode trips once routes arrive, then render the current frame.
  useEffect(() => {
    if (routesReady && routes) tripsRef.current?.show(routes);
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesReady, routes]);

  // Scroll position sets the target; the easing loop catches up to it.
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      targetPRef.current = max > 0 ? clamp01(window.scrollY / max) : 0;
      kick();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [kick]);

  const counts = reach
    ? { 11: reach.near.length, 45: reach.near.length + reach.ring.length }
    : null;
  const showIntro = phase === "intro" || phase === "zoom";

  return (
    <>
      {/* Pinned map: stays in place while the page scrolls. */}
      <div className="fixed inset-0">
        <div ref={containerRef} className="h-full w-full" />

        {/* Legend (color key + counts) */}
        <div className="absolute left-4 top-4 max-w-xs rounded-lg bg-white/90 p-4 shadow-lg backdrop-blur">
          <h1 className="text-base font-semibold text-gray-900">Citi Bike Sheds</h1>
          <p className="mt-1 text-sm text-gray-600">{selected?.name ?? "…"}</p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-3 space-y-1">
            {CONTOURS.map((c) => (
              <div key={c.minutes} className="flex items-center gap-2 text-xs text-gray-600">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                {c.label}
                {counts && (
                  <span className="ml-auto font-medium text-gray-900">
                    {counts[c.minutes]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Phase captions (crossfade) */}
        <div className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center px-4">
          <div className="relative h-24 w-full max-w-2xl">
            <Caption active={showIntro}>
              <span className="block text-2xl font-semibold text-gray-900">
                Where can a Citi Bike take you?
              </span>
              <span className="mt-2 block text-base text-gray-600">
                Scroll to ride out from {selected?.name ?? "this station"}.
              </span>
            </Caption>
            <Caption active={phase === "near"}>
              <span className="block text-2xl font-semibold text-gray-900">
                How far does a $3 Citi bike ride take you today?
              </span>
            </Caption>
            <Caption active={phase === "ring"}>
              <span className="block text-2xl font-semibold text-gray-900">
                And if 45 minute rides were capped at $3?
              </span>
            </Caption>
          </div>
        </div>
      </div>

      {/* Scroll track: gives the page height so the wheel scrubs the phases. */}
      <div aria-hidden style={{ height: `${SCROLL_VH}vh` }} />
    </>
  );
}

function Caption({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className={`absolute inset-x-0 bottom-0 rounded-xl bg-white/85 px-6 py-4 text-center shadow-lg backdrop-blur transition-opacity duration-500 ${
        active ? "opacity-100" : "opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

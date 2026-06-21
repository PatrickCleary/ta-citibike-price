import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { CONTOURS, fetchReach } from "../lib/sheds";
import {
  StationWave,
  stationPaint,
  STATIONS_SOURCE,
  STATIONS_LAYER,
  type StationPoint,
} from "../lib/stationWave";
import { TripLines, COLOR_RING, type TierState } from "../lib/tripLines";
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

const EMPTY: Set<string> = new Set();

// Full-metro view shown before a station is picked.
const FULL_VIEW = { center: [-73.95, 40.71] as [number, number], zoom: 10.3 };

// Animation timeline. A single p ∈ [0,1] is driven by the prev/next buttons
// (not scroll) and plays, in order: fly into the station → draw the ≤11-min
// trips → fade the ≤11 set out → draw the 45-min ring.
const FLY_END = 0.15; // [0, .15)   zoom from the metro into the station
const NEAR_END = 0.5; // [.15, .5)  ≤11-min trips draw
const FADE_END = 0.7; // [.5, .7)   ≤11-min trips fade out completely
//                       [.7, 1]    45-min ring draws

// Narrated steps the prev/next buttons move between. `p` is the timeline target
// each lands on; `dur` is how long that transition plays (ms); `title` is the
// caption shown while on that step.
const STEPS = [
  { key: "near", p: NEAR_END, dur: 2200, title: "How far does a $3 Citi Bike ride take you today?" },
  { key: "fade", p: FADE_END, dur: 1400, title: "We want to subsidize it to 45 minutes." },
  { key: "ring", p: 1.0, dur: 2400, title: "Here's how far $3 could take you." },
] as const;

// Camera fit.
const MAX_ZOOM = 18;
const MIN_ZOOM = 8.5;
const FIT_PAD_PX = 0;
const FIT_BUFFER = 1;

type Phase = "intro" | "fly" | "near" | "fade" | "ring";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// Zoom that fits a radius (metres) around `lat` within the map viewport.
function zoomForRadius(map: maplibregl.Map, lat: number, radiusM: number): number {
  const c = map.getCanvas();
  const avail = Math.min(c.clientWidth, c.clientHeight) / 2 - FIT_PAD_PX;
  if (!(radiusM > 0) || avail <= 0) return MAX_ZOOM;
  // 78271.517 = world circumference / 512 (MapLibre uses 512px tiles, so the
  // world is 512px wide at zoom 0 — NOT the 256px-tile 156543 value).
  const mppAtZ0 = 78271.51696 * Math.cos((lat * Math.PI) / 180);
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
  const appliedRef = useRef(false); // origin styling currently applied?
  const introRef = useRef(false); // intro ripple already played?
  const coordsRef = useRef(new globalThis.Map<string, [number, number]>()); // id → [lng, lat]
  const curPRef = useRef(0); // current point on the animation timeline [0,1]
  const animRef = useRef<number | null>(null); // in-flight tween rAF
  const stepRef = useRef(-1); // current step index (−1 = intro, no selection)
  const startedRef = useRef(false); // has the ≤11 draw kicked off for this pick?
  const flyFromRef = useRef<{ center: [number, number]; zoom: number } | null>(null); // camera at pick time

  const [selected, setSelected] = useState<Selected | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [routes, setRoutes] = useState<Awaited<ReturnType<typeof fetchRoutes>>>(null);
  const [routesReady, setRoutesReady] = useState(false);
  const [step, setStep] = useState(-1); // mirrors stepRef for button render
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
    // Pan/zoom stay enabled (defaults) so the intro is explorable; they're
    // locked while the camera-driven story plays. Rotation/pitch stay off (2D).
    map.dragRotate.disable();
    map.touchPitch.disable();

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
           }
        }
        waveRef.current?.setStations(list);
        playIntro();
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

      // Station layer now exists → paint the current frame and (once stations
      // have also loaded) ripple the field in.
      render();
      playIntro();
    });

    return () => {
      waveRef.current?.dispose();
      tripsRef.current?.dispose();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ripple the whole station field in, once stations + layer are both ready.
  const playIntro = useCallback(() => {
    const wave = waveRef.current;
    const map = mapRef.current;
    if (introRef.current || !wave || !map?.getLayer(STATIONS_LAYER)) return;
    if (coordsRef.current.size === 0) return; // stations not loaded yet
    introRef.current = true;
    wave.appearAll(FULL_VIEW.center);
    wave.start();
  }, []);

  // Enable/disable user pan + zoom (rotation/pitch stay off). Locked while the
  // story's camera animation runs; unlocked in the pickable intro.
  function setInteractive(on: boolean) {
    const map = mapRef.current;
    if (!map) return;
    const fn = on ? "enable" : "disable";
    map.scrollZoom[fn]();
    map.dragPan[fn]();
    map.doubleClickZoom[fn]();
    map.touchZoomRotate[fn]();
    map.boxZoom[fn]();
    map.keyboard[fn]();
  }

  function loadReach(id: string, name: string) {
    setError(null);
    setInteractive(false); // lock the map for the camera-driven story
    // Fly in from wherever the user left the intro camera, not a fixed view.
    const c = mapRef.current?.getCenter();
    flyFromRef.current = c
      ? { center: [c.lng, c.lat], zoom: mapRef.current!.getZoom() }
      : null;
    setSelected({ id, name });
    setReach(null);
    setRoutes(null);
    setRoutesReady(false);
    appliedRef.current = false;
    startedRef.current = false;
    stepRef.current = -1;
    curPRef.current = 0;
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
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

  // Render one frame of the timeline at point `p` ∈ [0,1]: phase, dot isolation,
  // trip tiers, and a steady per-phase camera. Pure function of `p` + selection.
  const scrub = useCallback((p: number) => {
    const map = mapRef.current;
    const trips = tripsRef.current;
    const wave = waveRef.current;
    if (!map) return;

    const sel = selectedRef.current;
    const origin = sel ? coordsRef.current.get(sel.id) ?? null : null;

    const phase: Phase = !origin
      ? "intro"
      : p < FLY_END
        ? "fly"
        : p < NEAR_END
          ? "near"
          : p < FADE_END
            ? "fade"
            : "ring";

    // Isolate the origin dot once a station is picked; show the full field in
    // the intro so any station stays clickable.
    if (map.getLayer(STATIONS_LAYER)) {
      const want = origin ? sel!.id : null;
      const cur = map.getFilter(STATIONS_LAYER) as unknown[] | undefined;
      const curId = Array.isArray(cur) ? (cur[2] as string) : null;
      if (want !== curId) {
        map.setFilter(
          STATIONS_LAYER,
          want ? ["==", ["get", "station_id"], want] : null,
        );
      }
    }

    // Origin styling: applied once per pick (red marker + a little plop).
    if (origin && !appliedRef.current && wave) {
      wave.select({
        selectedId: sel!.id,
        near: EMPTY,
        ring: EMPTY,
        showNear: true,
        showRing: true,
        hideOthers: true,
      });
      wave.start();
      appliedRef.current = true;
    }

    // Trip tiers.
    if (trips) {
      if (phase === "intro" || phase === "fly") {
        trips.setTiers(HIDDEN, HIDDEN);
      } else if (phase === "near") {
        const np = clamp01((p - FLY_END) / (NEAR_END - FLY_END));
        trips.setTiers({ visible: true, progress: np, opacity: 1 }, HIDDEN);
      } else if (phase === "fade") {
        const fp = clamp01((p - NEAR_END) / (FADE_END - NEAR_END));
        trips.setTiers({ visible: true, progress: 1, opacity: 1 - fp }, HIDDEN);
      } else {
        // Second animation draws ALL trips together — the ≤11 set redraws
        // alongside the 11–45 ring so the full ≤45-min reach fans out at once,
        // all in the tier-2 blue (the ≤11 set drops its green here).
        const rp = clamp01((p - FADE_END) / (1 - FADE_END));
        trips.setTiers(
          { visible: true, progress: rp, opacity: 1, color: COLOR_RING },
          { visible: true, progress: rp, opacity: 1 },
        );
      }
    }

    // Camera: hold a steady fit per phase so the lines draw *within* the frame
    // instead of the camera chasing the drawing front. Fly zooms metro→≤11 fit;
    // ring eases ≤11 fit→45-min fit as the outer band draws.
    if (!origin) {
      map.jumpTo({ center: FULL_VIEW.center, zoom: FULL_VIEW.zoom });
    } else {
      const zNear = zoomForRadius(map, origin[1], (trips?.getNearRadius() ?? 0) * FIT_BUFFER + 150);
      const zAll = zoomForRadius(map, origin[1], (trips?.getAllRadius() ?? 0) * FIT_BUFFER + 150);
      if (phase === "fly") {
        // Ease from the user's pre-pick camera into the ≤11-min fit.
        const from = flyFromRef.current ?? { center: FULL_VIEW.center, zoom: FULL_VIEW.zoom };
        const t = easeInOut(clamp01(p / FLY_END));
        map.jumpTo({
          center: [lerp(from.center[0], origin[0], t), lerp(from.center[1], origin[1], t)],
          zoom: lerp(from.zoom, zNear, t),
        });
      } else if (phase === "ring") {
        const t = easeInOut(clamp01((p - FADE_END) / (1 - FADE_END)));
        map.jumpTo({ center: origin, zoom: lerp(zNear, zAll, t) });
      } else {
        map.jumpTo({ center: origin, zoom: zNear }); // near + fade hold the ≤11 fit
      }
    }
  }, []);

  // Paint the current frame without animating (e.g. after data lands).
  const render = useCallback(() => scrub(curPRef.current), [scrub]);

  // Animate the timeline from its current point to `target` over `dur` ms.
  const tweenTo = useCallback(
    (target: number, dur: number, onDone?: () => void) => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      const from = curPRef.current;
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = dur <= 0 ? 1 : clamp01((now - t0) / dur);
        curPRef.current = from + (target - from) * easeInOut(k);
        scrub(curPRef.current);
        if (k < 1) {
          animRef.current = requestAnimationFrame(tick);
        } else {
          animRef.current = null;
          curPRef.current = target;
          scrub(target);
          onDone?.();
        }
      };
      animRef.current = requestAnimationFrame(tick);
    },
    [scrub],
  );

  // --- step navigation ----------------------------------------------------
  const goToStep = useCallback(
    (i: number) => {
      stepRef.current = i;
      setStep(i);
      tweenTo(STEPS[i].p, STEPS[i].dur);
    },
    [tweenTo],
  );

  // Rewind the whole story and return to the pickable intro field.
  const deselect = useCallback(() => {
    stepRef.current = -1;
    setStep(-1);
    tweenTo(0, 1200, () => {
      setSelected(null);
      selectedRef.current = null; // immediate, so render() clears the dot filter
      startedRef.current = false;
      appliedRef.current = false;
      tripsRef.current?.clear();
      render(); // no origin → unfilter the field + reset the camera
      waveRef.current?.reset();
      waveRef.current?.appearAll(FULL_VIEW.center);
      waveRef.current?.start();
      setInteractive(true); // intro is explorable again
    });
  }, [tweenTo, render]);

  const next = useCallback(() => {
    if (stepRef.current < STEPS.length - 1) goToStep(stepRef.current + 1);
  }, [goToStep]);

  const back = useCallback(() => {
    if (stepRef.current > 0) goToStep(stepRef.current - 1);
    else deselect();
  }, [goToStep, deselect]);

  // Once routes for the pick arrive, draw them and play fly-in + the ≤11 draw.
  useEffect(() => {
    if (!(routesReady && routes && selectedRef.current)) return;
    tripsRef.current?.show(routes);
    if (startedRef.current) {
      render(); // already mid-story; just repaint with the new data
      return;
    }
    startedRef.current = true;
    stepRef.current = 0;
    setStep(0);
    curPRef.current = 0;
    tweenTo(STEPS[0].p, STEPS[0].dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routesReady, routes]);

  const counts = reach
    ? { 11: reach.near.length, 45: reach.near.length + reach.ring.length }
    : null;
  const lastStep = STEPS.length - 1;

  return (
    <>
      {/* Full-screen map behind everything. */}
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
      </div>

      {/* Intro prompt — shown until a station is picked. */}
      {!selected && (
        <div className="pointer-events-none fixed inset-x-0 top-24 flex justify-center px-4">
          <div className="max-w-xl rounded-xl bg-white/85 px-6 py-4 text-center shadow-lg backdrop-blur">
            <span className="block text-2xl font-semibold text-gray-900">
              Where can a Citi Bike take you?
            </span>
            <span className="mt-2 block text-base text-gray-600">
              Click any station to ride out from it.
            </span>
          </div>
        </div>
      )}

      {/* Step caption + prev/next controls — shown while a station is active. */}
      {selected && step >= 0 && (
        <div className="fixed inset-x-0 bottom-8 flex flex-col items-center gap-4 px-4">
          <div className="pointer-events-none max-w-2xl rounded-xl bg-white/85 px-6 py-4 text-center shadow-lg backdrop-blur">
            <span className="block text-2xl font-semibold text-gray-900">
              {STEPS[step].title}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={back}
              className="rounded-full bg-white/90 px-5 py-2 text-sm font-medium text-gray-900 shadow-lg backdrop-blur hover:bg-white"
            >
              {step === 0 ? "↺ Pick another" : "‹ Back"}
            </button>
            <button
              onClick={next}
              disabled={step === lastStep}
              className="rounded-full bg-gray-900 px-5 py-2 text-sm font-medium text-white shadow-lg hover:bg-gray-700 disabled:opacity-40"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </>
  );
}

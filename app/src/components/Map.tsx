import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { CONTOURS, fetchReach, type ContourMinutes } from "../lib/sheds";
import {
  StationWave,
  stationPaint,
  STATIONS_SOURCE,
  STATIONS_LAYER,
  type StationPoint,
} from "../lib/stationWave";
import { TripLines } from "../lib/tripLines";
import { fetchRoutes } from "../lib/trips";

const STADIA_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;
// Custom "Alidade Smooth, no labels" style. Its tiles/sprite are served by
// Stadia (keyless on localhost); transformRequest below appends the API key in
// production.
const STYLE_URL = "/data/custom_adilade_no_labels.json";

// Attach the Stadia API key to any Stadia request when one is configured.
const transformRequest: maplibregl.RequestTransformFunction = (url) => {
  if (STADIA_KEY && url.includes("stadiamaps.com")) {
    return { url: `${url}${url.includes("?") ? "&" : "?"}api_key=${STADIA_KEY}` };
  }
  return { url };
};

const INITIAL = { center: [-73.97, 40.73] as [number, number], zoom: 11.5 };
const EMPTY: Set<string> = new Set();

// Station shown on load; scrolling scrubs its trips out.
const AUTO_ID = "1965202298784063998";
// Scroll track height (vh). The map is pinned; this much scroll = progress 0→1.
const SCROLL_VH = 500;
// Camera: start tight on the station, zoom out to follow the trips.
const MAX_ZOOM = 18;
const MIN_ZOOM = 10.5;
const FIT_PAD_PX = 80; // viewport padding when fitting the drawn radius
const FIT_BUFFER = 1.25; // extra room beyond the furthest trip

// Zoom that fits a radius (metres) around `lat` within the map viewport.
function zoomForRadius(map: maplibregl.Map, lat: number, radiusM: number): number {
  const c = map.getCanvas();
  const avail = Math.min(c.clientWidth, c.clientHeight) / 2 - FIT_PAD_PX;
  if (!(radiusM > 0) || avail <= 0) return MAX_ZOOM;
  const mppAtZ0 = 156543.03392 * Math.cos((lat * Math.PI) / 180); // metres/px at zoom 0
  const z = Math.log2((avail * mppAtZ0) / radiusM);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

type Mode = ContourMinutes | "both";

interface Selected {
  id: string;
  name: string;
}

// Reachable station ids, split into the ≤11-min set and the 11–45-min ring
// (stations reachable within 45 min but not within 11).
interface Reach {
  near: string[];
  ring: string[];
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const waveRef = useRef<StationWave | null>(null);
  const tripsRef = useRef<TripLines | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);
  const [routes, setRoutes] = useState<Awaited<ReturnType<typeof fetchRoutes>>>(null);
  const [routesReady, setRoutesReady] = useState(false); // routes fetch settled (value or null)
  const [mode, setMode] = useState<Mode>("both");
  const [error, setError] = useState<string | null>(null);

  // --- one-time map setup -------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: INITIAL.center,
      zoom: INITIAL.zoom,
      transformRequest,
    });
    mapRef.current = map;
    waveRef.current = new StationWave(map);
    tripsRef.current = new TripLines(map);
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.scrollZoom.disable(); // wheel scrolls the page (drives the animation)

    // Coordinates for the wave; also auto-select the starting station on load.
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
            if (id === AUTO_ID) autoName = f.properties?.name ?? autoName;
          }
        }
        waveRef.current?.setStations(list);
        loadReach(AUTO_ID, autoName); // show the starting station immediately
      })
      .catch(() => {});

    map.on("load", () => {
      // promoteId lets us drive per-feature animation via feature-state.
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
    tripsRef.current?.clear(); // drop the previous station's lines immediately
    // Reachable lists (counts + no-routes fallback) and routed geometries
    // (trip lines + dot arrival timing) load in parallel.
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

  const showNear = mode === "both" || mode === 11;
  const showRing = mode === "both" || mode === 45;

  // Map scroll position → trip progress + camera. Origin stays centered; zoom
  // starts tight (MAX_ZOOM) and eases out to fit the trips' growing radius.
  const scrubToScroll = useCallback(() => {
    const trips = tripsRef.current;
    const map = mapRef.current;
    if (!trips) return;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    trips.setProgress(maxScroll > 0 ? window.scrollY / maxScroll : 0);
    const origin = trips.getOrigin();
    if (map && origin) {
      const radius = trips.getDrawnRadius() * FIT_BUFFER + 150; // floor keeps z≈MAX at start
      map.jumpTo({ center: origin, zoom: zoomForRadius(map, origin[1], radius) });
    }
  }, []);

  // Apply the current selection's dots + lines. `restart` replays the draw-out;
  // otherwise it just recolors/retiers in place (e.g. on a mode toggle).
  function applySelection(restart: boolean) {
    const wave = waveRef.current;
    const trips = tripsRef.current;
    if (!wave || !selected) return;

    if (routes) {
      // Routed: trip lines + their head/dock dots render the destinations, so
      // the MapLibre station layer shows only the origin (others hidden).
      if (restart) trips?.show(routes, showNear, showRing);
      else trips?.setVisibility(showNear, showRing);
      wave.select({
        selectedId: selected.id,
        near: EMPTY, ring: EMPTY, showNear, showRing,
        hideOthers: true,
      });
    } else if (reach) {
      // No routes for this station: fall back to the distance ripple.
      wave.select({
        selectedId: selected.id,
        near: new Set(reach.near),
        ring: new Set(reach.ring),
        showNear, showRing,
      });
    } else {
      return;
    }
    if (restart) wave.start();
    else wave.refresh();
    scrubToScroll(); // sync progress + camera to current scroll position
  }

  // Selection fully loaded (reach + routes settled) → run the animation.
  useEffect(() => {
    if (!selected || !reach || !routesReady) return;
    applySelection(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, reach, routesReady]);

  // Mode toggle → recolor dots + retier visible trip lines instantly.
  useEffect(() => {
    applySelection(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Scroll position scrubs the trip draw-out + camera (rAF-throttled).
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        scrubToScroll();
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // sync initial progress
    return () => window.removeEventListener("scroll", onScroll);
  }, [scrubToScroll]);

  const counts = reach
    ? { 11: reach.near.length, 45: reach.near.length + reach.ring.length }
    : null;

  return (
    <>
      {/* Pinned map: stays in place while the page scrolls. */}
      <div className="fixed inset-0">
        <div ref={containerRef} className="h-full w-full" />

      {/* Title / legend */}
      <div className="absolute left-4 top-4 max-w-xs rounded-lg bg-white/90 p-4 shadow-lg backdrop-blur">
        <h1 className="text-base font-semibold text-gray-900">Citi Bike Sheds</h1>
        <p className="mt-1 text-sm text-gray-600">
          {selected ? selected.name : "Click a station to see which stations you can reach."}
        </p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        {selected && (
          <div className="mt-3 flex gap-1 rounded-md bg-gray-100 p-1">
            {(["both", ...CONTOURS.map((c) => c.minutes)] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium transition ${
                  mode === m
                    ? "bg-white text-gray-900 shadow"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {m === "both" ? "Both" : `${m} min`}
              </button>
            ))}
          </div>
        )}

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

      {/* Scroll track: gives the page height so the wheel scrubs the trips. */}
      <div aria-hidden style={{ height: `${SCROLL_VH}vh` }} />
    </>
  );
}

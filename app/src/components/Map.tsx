import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { CONTOURS, fetchShed, type ContourMinutes } from "../lib/sheds";

const STADIA_KEY = import.meta.env.PUBLIC_STADIA_API_KEY;
// Stadia "Alidade Smooth" — clean, low-contrast base that lets the sheds pop.
const STYLE_URL = `https://tiles.stadiamaps.com/styles/alidade_smooth.json${
  STADIA_KEY ? `?api_key=${STADIA_KEY}` : ""
}`;

const INITIAL = { center: [-73.97, 40.73] as [number, number], zoom: 11.5 };

const SHED_SOURCE = "shed";
const STATIONS_SOURCE = "stations";
type Mode = ContourMinutes | "both";

interface Selected {
  id: string;
  name: string;
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
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
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      // Stations: one slim GeoJSON, rendered as circles.
      map.addSource(STATIONS_SOURCE, {
        type: "geojson",
        data: "/stations.geojson",
      });

      // Empty shed source; populated on click. Two fill layers, larger contour
      // underneath so the faster ring stays readable on top.
      map.addSource(SHED_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      for (const c of [...CONTOURS].reverse()) {
        map.addLayer({
          id: `shed-fill-${c.minutes}`,
          type: "fill",
          source: SHED_SOURCE,
          filter: ["==", ["get", "contour"], c.minutes],
          paint: { "fill-color": c.color, "fill-opacity": 0.22 },
        });
        map.addLayer({
          id: `shed-line-${c.minutes}`,
          type: "line",
          source: SHED_SOURCE,
          filter: ["==", ["get", "contour"], c.minutes],
          paint: { "line-color": c.color, "line-width": 1.5, "line-opacity": 0.9 },
        });
      }

      map.addLayer({
        id: "stations",
        type: "circle",
        source: STATIONS_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6],
          "circle-color": "#1f2937",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.85,
        },
      });

      map.on("click", "stations", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = f.properties?.station_id as string;
        const name = (f.properties?.name as string) ?? "Station";
        loadShed(id, name);
      });
      map.on("mouseenter", "stations", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "stations", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadShed(id: string, name: string) {
    setError(null);
    setSelected({ id, name });
    try {
      const fc = await fetchShed(id);
      const src = mapRef.current?.getSource(SHED_SOURCE) as
        | maplibregl.GeoJSONSource
        | undefined;
      src?.setData(fc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // --- highlight the selected station, fade the rest ----------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("stations")) return;
    const id = selected?.id;
    if (!id) {
      map.setPaintProperty("stations", "circle-color", "#1f2937");
      map.setPaintProperty("stations", "circle-opacity", 0.85);
      map.setPaintProperty("stations", "circle-stroke-color", "#ffffff");
      map.setPaintProperty("stations", "circle-radius", [
        "interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6,
      ]);
      return;
    }
    const isSelected = ["==", ["get", "station_id"], id];
    map.setPaintProperty("stations", "circle-color", [
      "case", isSelected, "#ff2d55", "#1f2937",
    ]);
    map.setPaintProperty("stations", "circle-opacity", [
      "case", isSelected, 1, 0.25,
    ]);
    map.setPaintProperty("stations", "circle-stroke-color", [
      "case", isSelected, "#ff2d55", "#ffffff",
    ]);
    map.setPaintProperty("stations", "circle-radius", [
      "case",
      isSelected,
      ["interpolate", ["linear"], ["zoom"], 10, 6, 15, 11],
      ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6],
    ]);
  }, [selected]);

  // --- contour visibility follows `mode` ----------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    for (const c of CONTOURS) {
      const visible = mode === "both" || mode === c.minutes ? "visible" : "none";
      map.setLayoutProperty(`shed-fill-${c.minutes}`, "visibility", visible);
      map.setLayoutProperty(`shed-line-${c.minutes}`, "visibility", visible);
    }
  }, [mode, selected]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* Title / legend */}
      <div className="absolute left-4 top-4 max-w-xs rounded-lg bg-white/90 p-4 shadow-lg backdrop-blur">
        <h1 className="text-base font-semibold text-gray-900">Citi Bike Sheds</h1>
        <p className="mt-1 text-sm text-gray-600">
          {selected ? selected.name : "Click a station to see how far you can ride."}
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
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: c.color, opacity: 0.6 }}
              />
              {c.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

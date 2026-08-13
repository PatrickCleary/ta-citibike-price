import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createStationSearcher } from "../lib/stationSearch";
import { searchAddresses } from "../lib/geocodeSearch";
import type { StationPoint } from "../lib/dockController";

export type Suggestion =
  | { type: "station"; id: string; label: string; lat: number; lon: number }
  | { type: "address"; id: string; label: string; lat: number; lon: number };

interface SearchBarProps {
  stations: StationPoint[];
  mapCenter?: maplibregl.LngLat;
  onSelect: (result: Suggestion) => void;
  onClear: () => void;
}

export function SearchBar({
  stations,
  mapCenter,
  onSelect,
  onClear,
}: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);

  const searchStations = useMemo(
    () => createStationSearcher(stations),
    [stations],
  );
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipNextSearch = useRef(false);

  const runSearch = useCallback(
    async (q: string) => {
      if (q.length < 3) return;

      const stationResults: Suggestion[] = searchStations(q, 5).map((s) => ({
        type: "station",
        id: s.id,
        label: s.name,
        lat: s.lat,
        lon: s.lon,
      }));
      setOpen(true);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const addressResults = await searchAddresses(
          q,
          mapCenter,
          controller.signal,
        );
        const merged: Suggestion[] = [
          ...stationResults,
          ...addressResults.map((a) => ({
            type: "address" as const,
            id: a.id,
            label: a.label,
            lat: a.lat,
            lon: a.lon,
          })),
        ];
        setSuggestions(merged.slice(0, 10));
      } catch (err: any) {
        if (err.name !== "AbortError") console.error(err);
      } finally {
        setLoading(false);
      }
    },
    [mapCenter, searchStations],
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);

    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }

    if (!query) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(query), 250);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const handleSelect = (s: Suggestion) => {
    skipNextSearch.current = true;
    onSelect(s);
    setQuery(s.label);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative w-full pointer-events-auto shadow-lg">
      <div className="absolute inset-y-0 left-0 flex items-center pl-3.5">
        <svg
          className="h-4 w-4 text-slate-400"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-4.35-4.35m0 0a7.5 7.5 0 10-10.6 0 7.5 7.5 0 0010.6 0z"
          />
        </svg>
      </div>

      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder="Search stations or places…"
        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-9
                    text-sm text-slate-800 placeholder:text-slate-400 shadow-sm
                    outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
      />
      <div className="absolute inset-y-0 right-0 flex items-center pr-3">
        {loading ? (
          <svg
            className="h-4 w-4 animate-spin text-sky-500"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        ) : query ? (
          <button
            onClick={() => {
              setQuery("");
              setSuggestions([]);
              setOpen(false);
              onClear();
            }}
            className="rounded-xl p-0.5 text-slate-400 hover:text-slate-600"
            aria-label="Clear search"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        ) : null}
      </div>

      {open && suggestions.length > 0 && (
        <ul
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border
                      border-slate-100 bg-white py-1.5 shadow-lg ring-1 ring-black/5
                      animate-in fade-in slide-in-from-top-1 duration-150"
        >
          {suggestions.map((s, i) => (
            <li key={`${s.type}-${s.id}`}>
              <button
                onClick={() => handleSelect(s)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition
                    ${i === activeIndex ? "bg-sky-50 text-slate-900" : "text-slate-700 hover:bg-slate-50"}`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs
                      ${
                        s.type === "station"
                          ? "bg-sky-100 text-sky-600"
                          : "bg-amber-100 text-amber-600"
                      }`}
                >
                  {s.type === "station" ? "🚲" : "📍"}
                </span>
                <span className="flex-1 truncate">{s.label}</span>
                <span className="shrink-0 text-[11px] uppercase tracking-wide text-slate-300">
                  {s.type === "station" ? "Station" : "Address"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Empty state */}
      {open && !loading && query.length >= 3 && suggestions.length === 0 && (
        <div
          className="absolute z-20 mt-2 w-full rounded-2xl border border-slate-100 bg-white
                          px-4 py-3 text-sm text-slate-400 shadow-lg ring-1 ring-black/5"
        >
          No results for "{query}"
        </div>
      )}
    </div>
  );
}

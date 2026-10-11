#!/usr/bin/env python3
"""Build the combined 5-min walk shed around a station's reachable trip ends.

For an origin station, takes the origin plus every station reachable within
11 and 45 min (reachable/<id>.json) and unions each one's 5-minute walking
isochrone into a single shape per tier.

Per-station walk sheds come from the local Valhalla service (pedestrian
costing) and are cached, since every origin reuses the same ones:

    walksheds/<station_id>.geojson        # one station's 5-min walk polygon(s)

The per-origin union is written as:

    walkshed_unions/<station_id>.geojson  # FeatureCollection, one feature per tier
        properties: {"station_id", "tier": 11 | 45, "stations": <count>}

Usage:  python3 compute_walksheds.py [station_id] [--force]

With no station_id, builds every station that has a reachable file, skipping
ones already in walkshed_unions/ unless --force (e.g. after changing SMOOTH_M).
"""
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import (ProcessPoolExecutor, ThreadPoolExecutor,
                                as_completed)

from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

VALHALLA = "http://localhost:8002/isochrone"
WALK_MINUTES = 5
REACHDIR = "reachable"
EXCLUDED = "excluded_stations.json"  # never unioned in as a destination
SHEDDIR = "walksheds"
OUTDIR = "walkshed_unions"
WORKERS = 8
RETRIES = 3
SMOOTH_M = 50  # rounds off spikes/notches narrower than ~2x this
SIMPLIFY_M = 5  # trims vertex count on the smoothed outline
MAX_HOLE_M2 = 200_000  # interior holes smaller than this (~0.2 km²) are filled


def fetch_walkshed(station):
    """Return the cached (or freshly fetched) 5-min walk shed for a station."""
    sid = station["station_id"]
    path = os.path.join(SHEDDIR, f"{sid}.geojson")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path) as f:
            return sid, json.load(f), None

    payload = {
        "locations": [{"lat": station["lat"], "lon": station["lon"]}],
        "costing": "pedestrian",
        "contours": [{"time": WALK_MINUTES}],
        "polygons": True,
        "denoise": 0.5,
        "generalize": 20,
        "id": sid,
    }
    data = json.dumps(payload).encode()
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(VALHALLA, data=data,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                fc = json.loads(r.read())
            for feat in fc.get("features", []):
                feat.setdefault("properties", {})["station_id"] = sid
            tmp = path + ".tmp"
            with open(tmp, "w") as out:
                json.dump(fc, out)
            os.replace(tmp, path)
            return sid, fc, None
        except Exception as e:  # noqa
            last = e
            time.sleep(1.0 * (attempt + 1))
    return sid, None, f"FAIL: {last}"


def fill_small_holes(geom):
    """Drop interior rings under MAX_HOLE_M2 (geom must be in metres)."""
    def fill(poly):
        keep = [r for r in poly.interiors if Polygon(r).area >= MAX_HOLE_M2]
        return Polygon(poly.exterior, keep)
    if isinstance(geom, Polygon):
        return fill(geom)
    return MultiPolygon([fill(p) for p in geom.geoms])


def smooth(geom, lat):
    """Round off the walk shed's spiky street-following edges.

    Works in local metres (lon scaled by cos(lat)) so buffers are round.
    Grow-then-shrink fills narrow notches; shrink-then-grow drops thin spikes.
    """
    m_per_deg = 111_320
    kx = m_per_deg * math.cos(math.radians(lat))
    g = affinity.scale(geom, kx, m_per_deg, origin=(0, 0))
    g = g.buffer(SMOOTH_M).buffer(-2 * SMOOTH_M).buffer(SMOOTH_M)
    g = fill_small_holes(g).simplify(SIMPLIFY_M, preserve_topology=True)
    return affinity.scale(g, 1 / kx, 1 / m_per_deg, origin=(0, 0))


def load_sheds(stations):
    """Fetch (or read cached) walk sheds for every station -> {sid: geom}."""
    os.makedirs(SHEDDIR, exist_ok=True)
    t0 = time.time()
    sheds, failures = {}, []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for sid, fc, err in ex.map(fetch_walkshed, stations.values()):
            if fc is None:
                failures.append((sid, err))
                continue
            # buffer(0) repairs any self-intersecting rings before the union.
            sheds[sid] = unary_union(
                [shape(ft["geometry"]) for ft in fc["features"]]).buffer(0)
    print(f"walk sheds: {len(sheds)} ok, {len(failures)} failed "
          f"in {time.time()-t0:.0f}s", flush=True)
    for sid, err in failures[:20]:
        print(" ", sid, err)
    return sheds


# Per-process state for the union workers, set once by init_worker so each
# task doesn't re-pickle every station's walk shed.
_stations = _sheds = _excluded = None


def init_worker(stations):
    global _stations, _sheds, _excluded
    with open(EXCLUDED) as f:
        _excluded = set(json.load(f)["stations"])
    _stations = stations
    _sheds = {}
    for sid in stations:
        path = os.path.join(SHEDDIR, f"{sid}.geojson")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            with open(path) as f:
                fc = json.load(f)
            _sheds[sid] = unary_union(
                [shape(ft["geometry"]) for ft in fc["features"]]).buffer(0)


def build_union(origin):
    """Union and smooth one origin's tiers; write walkshed_unions/<origin>."""
    with open(os.path.join(REACHDIR, f"{origin}.json")) as f:
        reach = json.load(f)
    features, summary = [], []
    for t in (11, 45):
        ids = [origin] + [d for d in reach[str(t)]
                          if d in _stations and d not in _excluded]
        geoms = [_sheds[s] for s in ids if s in _sheds]
        if not geoms:
            continue
        merged = smooth(unary_union(geoms), _stations[origin]["lat"])
        features.append({
            "type": "Feature",
            "properties": {"station_id": origin, "tier": t,
                           "stations": len(geoms)},
            "geometry": mapping(merged),
        })
        parts = len(getattr(merged, "geoms", [merged]))
        summary.append(f"≤{t}: {len(geoms)} stations, {parts} part(s)")

    path = os.path.join(OUTDIR, f"{origin}.geojson")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"type": "FeatureCollection", "station_id": origin,
                   "walk_minutes": WALK_MINUTES, "features": features}, f)
    os.replace(tmp, path)
    return origin, "; ".join(summary)


def main():
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv[1:]
    if len(args) > 1:
        sys.exit("Usage: python3 compute_walksheds.py [station_id] [--force]")

    with open("stations.json") as f:
        stations = {s["station_id"]: s
                    for s in json.load(f)["data"]["stations"]}
    os.makedirs(OUTDIR, exist_ok=True)

    if args:
        origin = args[0]
        if origin not in stations:
            sys.exit(f"Unknown station_id {origin}")
        load_sheds(stations)
        init_worker(stations)
        sid, summary = build_union(origin)
        print(f"wrote {OUTDIR}/{sid}.geojson  {summary}")
        return

    reachable = {fn[:-5] for fn in os.listdir(REACHDIR)
                 if fn.endswith(".json")}
    done = {fn[:-8] for fn in os.listdir(OUTDIR) if fn.endswith(".geojson")}
    todo = sorted(s for s in reachable
                  if s in stations and (force or s not in done))
    print(f"{len(todo)} origins to build "
          f"({len(reachable) - len(todo)} skipped)", flush=True)
    if not todo:
        return

    load_sheds(stations)
    t0 = time.time()
    failures = []
    with ProcessPoolExecutor(initializer=init_worker,
                             initargs=(stations,)) as ex:
        futs = {ex.submit(build_union, s): s for s in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                fut.result()
            except Exception as e:  # noqa
                failures.append((futs[fut], repr(e)))
            if i % 50 == 0 or i == len(todo):
                rate = i / (time.time() - t0)
                eta = (len(todo) - i) / rate if rate else 0
                print(f"{i}/{len(todo)}  fail={len(failures)}  "
                      f"{rate:.1f}/s  ETA {eta/60:.1f}m", flush=True)
    print(f"\nDONE in {(time.time()-t0)/60:.1f}m  fail={len(failures)}")
    for sid, err in failures[:20]:
        print(" ", sid, err)


if __name__ == "__main__":
    main()

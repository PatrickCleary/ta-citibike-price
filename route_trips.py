#!/usr/bin/env python3
"""Route every reachable trip from a station via a local OSRM server.

For a given origin station, looks up the stations reachable within 11 and 45
min (reachable/<id>.json) and asks OSRM for the bike route to each. Geometries
are stored as polyline-encoded strings (precision 5, OSRM's `geometries=polyline`).

Writes routes/<station_id>.json:

    {
      "station_id": "...",
      "origin": [lon, lat],
      "profile": "bike",
      "precision": 5,
      "11": {"<dest_id>": "<polyline>", ...},   # trips reachable <= 11 min
      "45": {"<dest_id>": "<polyline>", ...}     # trips reachable <= 45 min (superset)
    }

The 45 set is a superset of 11; each destination is routed only once and the
polyline string is referenced in both tiers.

Usage:  python3 route_trips.py [station_id]
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

OSRM = "http://localhost:5000"
PROFILE = "bike"   # path segment is cosmetic; OSRM uses its compiled profile
REACHDIR = "reachable"
OUTDIR = "routes"
WORKERS = 16
RETRIES = 3

DEFAULT_STATION = "1965202298784063998"


def load_coords():
    with open("stations.json") as f:
        stations = json.load(f)["data"]["stations"]
    return {s["station_id"]: (s["lon"], s["lat"]) for s in stations}


def route(coords, origin_id, dest_id):
    olon, olat = coords[origin_id]
    dlon, dlat = coords[dest_id]
    url = (f"{OSRM}/route/v1/{PROFILE}/{olon},{olat};{dlon},{dlat}"
           f"?overview=full&geometries=polyline")
    last = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read())
            if data.get("code") != "Ok" or not data.get("routes"):
                return dest_id, None, f"no route ({data.get('code')})"
            return dest_id, data["routes"][0]["geometry"], None
        except Exception as e:  # noqa
            last = e
            time.sleep(0.5 * (attempt + 1))
    return dest_id, None, f"FAIL: {last}"


def route_station(sid, coords, ex):
    """Route every reachable trip from one station and write routes/<sid>.json.

    Reuses the shared ThreadPoolExecutor `ex`. Returns a (total, ok, fail)
    tuple, or None if the station has no reachable file.
    """
    reach_path = os.path.join(REACHDIR, f"{sid}.json")
    if not os.path.exists(reach_path):
        return None
    with open(reach_path) as f:
        reach = json.load(f)
    dests = [d for d in reach["45"] if d in coords]  # 45 is the full set
    missing_coords = len(reach["45"]) - len(dests)

    geom = {}
    failures = []
    futs = [ex.submit(route, coords, sid, d) for d in dests]
    for fut in as_completed(futs):
        dest_id, poly, err = fut.result()
        if poly is not None:
            geom[dest_id] = poly
        else:
            failures.append((dest_id, err))

    out = {
        "station_id": sid,
        "origin": list(coords[sid]),
        "profile": PROFILE,
        "precision": 5,
        "11": {d: geom[d] for d in reach["11"] if d in geom},
        "45": {d: geom[d] for d in reach["45"] if d in geom},
    }
    path = os.path.join(OUTDIR, f"{sid}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, path)
    return len(dests), len(geom), len(failures), missing_coords


def run_one(sid, coords):
    if sid not in coords:
        sys.exit(f"Unknown station_id {sid}")
    os.makedirs(OUTDIR, exist_ok=True)
    t0 = time.time()
    print(f"Routing trips from {sid} ...", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        res = route_station(sid, coords, ex)
    if res is None:
        sys.exit(f"No reachable file for {sid}")
    ok, fail = res[1], res[2]
    print(f"wrote {OUTDIR}/{sid}.json in {time.time()-t0:.0f}s  "
          f"ok={ok} fail={fail}", flush=True)


def run_all(coords):
    os.makedirs(OUTDIR, exist_ok=True)
    sids = sorted(fn[:-5] for fn in os.listdir(REACHDIR) if fn.endswith(".json"))
    done = {fn[:-5] for fn in os.listdir(OUTDIR) if fn.endswith(".json")}
    todo = [s for s in sids if s not in done]
    print(f"{len(sids)} stations, {len(done)} already routed, "
          f"{len(todo)} to go", flush=True)

    t0 = time.time()
    routes_total = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for i, sid in enumerate(todo, 1):
            if sid not in coords:
                print(f"  [{i}/{len(todo)}] {sid}: no coords, skipping", flush=True)
                continue
            res = route_station(sid, coords, ex)
            if res is None:
                continue
            ok, fail = res[1], res[2]
            routes_total += ok
            elapsed = time.time() - t0
            rate = routes_total / elapsed if elapsed else 0
            print(f"  [{i}/{len(todo)}] {sid}: ok={ok} fail={fail}  "
                  f"({rate:.0f} routes/s, {elapsed/60:.1f}m elapsed)", flush=True)
    print(f"\ndone: {len(todo)} stations, {routes_total} routes "
          f"in {(time.time()-t0)/60:.1f}m", flush=True)


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_STATION
    coords = load_coords()
    if arg == "all":
        run_all(coords)
    else:
        run_one(arg, coords)


if __name__ == "__main__":
    main()

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


def main():
    sid = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_STATION
    coords = load_coords()
    if sid not in coords:
        sys.exit(f"Unknown station_id {sid}")

    with open(os.path.join(REACHDIR, f"{sid}.json")) as f:
        reach = json.load(f)
    near = set(reach["11"])
    dests = [d for d in reach["45"] if d in coords]  # 45 is the full set
    missing_coords = len(reach["45"]) - len(dests)

    os.makedirs(OUTDIR, exist_ok=True)
    geom = {}
    failures = []
    t0 = time.time()
    total = len(dests)
    print(f"Routing {total} trips from {sid} ...", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(route, coords, sid, d) for d in dests]
        done = 0
        for fut in as_completed(futs):
            dest_id, poly, err = fut.result()
            done += 1
            if poly is not None:
                geom[dest_id] = poly
            else:
                failures.append((dest_id, err))
            if done % 100 == 0 or done == total:
                rate = done / (time.time() - t0)
                print(f"  {done}/{total}  {rate:.0f}/s  ok={len(geom)} "
                      f"fail={len(failures)}", flush=True)

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

    print(f"\nwrote {path} in {time.time()-t0:.0f}s")
    print(f"  11-min trips: {len(out['11'])}  45-min trips: {len(out['45'])}")
    if missing_coords:
        print(f"  {missing_coords} reachable ids had no station coords (skipped)")
    if failures:
        print(f"  {len(failures)} routing failures:")
        for d, e in failures[:10]:
            print("   ", d, e)


if __name__ == "__main__":
    main()

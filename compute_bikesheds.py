#!/usr/bin/env python3
"""Compute 11-min and 45-min bicycle bikesheds for every Citi Bike station
via a local Valhalla isochrone service. One GeoJSON per station in output/."""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

VALHALLA = "http://localhost:8002/isochrone"
OUTDIR = "output"
CONTOURS = [{"time": 11}, {"time": 45}]
WORKERS = 8
RETRIES = 3

os.makedirs(OUTDIR, exist_ok=True)

with open("stations.json") as f:
    stations = json.load(f)["data"]["stations"]


def fetch(station):
    sid = station["station_id"]
    path = os.path.join(OUTDIR, f"{sid}.geojson")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return sid, "skip"

    # denoise < 1.0 keeps smaller disconnected regions (not just the largest).
    # Note: a few boundary locations hit an internal Valhalla crash with denoise
    # set; those fail and are skipped (reported at the end of the run).
    payload = {
        "locations": [{"lat": station["lat"], "lon": station["lon"]}],
        "costing": "bicycle",
        "contours": CONTOURS,
        "polygons": True,
        "denoise": 0.5,
        "generalize": 50,
        "id": sid,
    }
    data = json.dumps(payload).encode()

    last_err = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(VALHALLA, data=data,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                fc = json.loads(r.read())
            # tag each feature + the collection with station identity
            for feat in fc.get("features", []):
                feat.setdefault("properties", {})["station_id"] = sid
            fc["station_id"] = sid
            fc["station_name"] = station.get("name")
            tmp = path + ".tmp"
            with open(tmp, "w") as out:
                json.dump(fc, out)
            os.replace(tmp, path)
            return sid, "ok"
        except Exception as e:  # noqa
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    return sid, f"FAIL: {last_err}"


def main():
    total = len(stations)
    done = ok = skip = fail = 0
    failures = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch, s): s for s in stations}
        for fut in as_completed(futs):
            sid, status = fut.result()
            done += 1
            if status == "ok":
                ok += 1
            elif status == "skip":
                skip += 1
            else:
                fail += 1
                failures.append((sid, status))
            if done % 50 == 0 or done == total:
                rate = done / (time.time() - t0)
                eta = (total - done) / rate if rate else 0
                print(f"{done}/{total}  ok={ok} skip={skip} fail={fail}  "
                      f"{rate:.1f}/s  ETA {eta:.0f}s", flush=True)
    print(f"\nDONE in {time.time()-t0:.0f}s  ok={ok} skip={skip} fail={fail}")
    if failures:
        print("Failures:")
        for sid, msg in failures[:50]:
            print(" ", sid, msg)
        sys.exit(1)


if __name__ == "__main__":
    main()

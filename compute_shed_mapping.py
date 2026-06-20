#!/usr/bin/env python3
"""Build per-station reachability lists from the bikeshed polygons.

Reads the per-station isochrone polygons in output/ (produced by
compute_bikesheds.py) and, for each station, records which OTHER stations fall
within its 11-min and 45-min bicycle sheds. Writes one small file per station:

    reachable/<station_id>.json  ->  {"11": ["<id>", ...], "45": ["<id>", ...]}

The "45" list is a superset of "11". The origin station is excluded from its
own lists. These files are served per-station to the web app the same way the
shed polygons are (upload with upload_to_supabase.py, prefix "reachable").
"""
import json
import os

from shapely.geometry import shape, Point
from shapely.strtree import STRtree

OUTDIR = "output"
REACHDIR = "reachable"


def main():
    with open("stations.json") as f:
        stations = json.load(f)["data"]["stations"]

    os.makedirs(REACHDIR, exist_ok=True)

    # Spatial index over all station points.
    ids = [s["station_id"] for s in stations]
    points = [Point(s["lon"], s["lat"]) for s in stations]
    tree = STRtree(points)

    written = missing = 0
    sum11 = sum45 = 0
    for sid in ids:
        path = os.path.join(OUTDIR, f"{sid}.geojson")
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            missing += 1
            continue
        with open(path) as f:
            fc = json.load(f)

        # Collect (possibly multiple) polygons per contour time.
        sheds = {}  # contour minutes -> list of geometries
        for feat in fc.get("features", []):
            t = feat["properties"].get("contour")
            sheds.setdefault(t, []).append(shape(feat["geometry"]))

        entry = {}
        for t in (11, 45):
            inside = set()
            for g in sheds.get(t, []):
                # STRtree query returns indices of points whose bbox intersects
                # the geometry's bbox; confirm with an exact containment test.
                for idx in tree.query(g):
                    if g.contains(points[idx]):
                        inside.add(ids[idx])
            inside.discard(sid)  # drop the origin station itself
            entry[str(t)] = sorted(inside)

        tmp = os.path.join(REACHDIR, f"{sid}.json.tmp")
        with open(tmp, "w") as out:
            json.dump(entry, out)
        os.replace(tmp, os.path.join(REACHDIR, f"{sid}.json"))
        written += 1
        sum11 += len(entry["11"])
        sum45 += len(entry["45"])

    avg11 = sum11 / written if written else 0
    avg45 = sum45 / written if written else 0
    print(f"wrote {written} files to {REACHDIR}/ "
          f"({missing} missing isochrones skipped)")
    print(f"avg reachable: 11-min={avg11:.1f}  45-min={avg45:.1f}")


if __name__ == "__main__":
    main()

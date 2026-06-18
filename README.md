# Citi Bike Bikesheds

11-minute and 45-minute **bicycle bikesheds** (isochrones) computed from every
Citi Bike station in NYC using a local [Valhalla](https://github.com/valhalla/valhalla)
routing engine.

A *bikeshed* is the area reachable from a station within a given time budget by
bike. We generate two per station and store them together as GeoJSON.

## Output

`output/<station_id>.geojson` — one file per station (2,412 total), named by the
station's `station_id`.

Each file is a GeoJSON `FeatureCollection` containing **two polygon features**:

| `properties.contour` | meaning                       |
|----------------------|-------------------------------|
| `11`                 | reachable within 11 minutes   |
| `45`                 | reachable within 45 minutes   |

Each feature also carries a `station_id`, and the collection carries top-level
`station_id` / `station_name` fields for convenience.

```jsonc
{
  "type": "FeatureCollection",
  "station_id": "dd482585-3028-453f-a98d-55019db9b26c",
  "station_name": "2 Ave & 36 St",
  "features": [
    { "type": "Feature", "properties": { "contour": 45, "metric": "time", "station_id": "..." }, "geometry": { "type": "Polygon", "coordinates": [...] } },
    { "type": "Feature", "properties": { "contour": 11, "metric": "time", "station_id": "..." }, "geometry": { "type": "Polygon", "coordinates": [...] } }
  ]
}
```

## Inputs

- `ny_nj_2026-02-17/NewYork.osm.pbf` — OSM extract of the NY/NJ region (~150 MB).
  Used to build the Valhalla routing graph.
- `stations.json` — Citi Bike GBFS `station_information` feed. We read
  `data.stations[].{station_id, lat, lon, name}` (2,412 stations).

> The other files in `ny_nj_2026-02-17/` (`*.osrm.*`) are **OSRM** preprocessed
> data and are **not used** — Valhalla builds its own tile format from the
> `.pbf`. See [Decisions](#decisions).

## Reproduce

Requirements: **Docker** (running) and **Python 3** (standard library only).

### 1. Build the Valhalla tiles and start the service

We use the [`gis-ops/docker-valhalla`](https://github.com/gis-ops/docker-valhalla)
image, which builds tiles from any `.pbf` it finds in the mounted
`/custom_files` directory and then serves them on port 8002.

```bash
mkdir -p valhalla output
cp ny_nj_2026-02-17/NewYork.osm.pbf valhalla/

docker run -d --name valhalla_citibike \
  -p 8002:8002 \
  -v "$PWD/valhalla:/custom_files" \
  -e serve_tiles=True \
  -e build_elevation=False \
  -e build_admins=True \
  -e build_time_zones=False \
  ghcr.io/gis-ops/docker-valhalla/valhalla:latest
```

The first run builds the graph (~5–6 minutes for this extract); tiles are
written into `./valhalla/` so subsequent starts are instant. Wait until the
service is ready:

```bash
curl -s http://localhost:8002/status   # returns JSON once up
```

> The build logs print `admin_access.admin_id` SQLite errors for various
> countries — these are **harmless** for a regional extract (they only matter
> for a full planet build) and can be ignored.

### 2. Compute the bikesheds

```bash
python3 compute_bikesheds.py
```

This reads `stations.json`, queries Valhalla's `/isochrone` endpoint for each
station (8 concurrent workers), and writes `output/<station_id>.geojson`. It
takes ~60 seconds for all 2,412 stations.

The script is **resumable** — it skips stations whose output already exists, so
you can re-run it safely after an interruption.

### 3. Tear down (optional)

```bash
docker stop valhalla_citibike    # keeps tiles in ./valhalla/
docker start valhalla_citibike   # restart later, no rebuild
docker rm -f valhalla_citibike   # remove container entirely
```

## Decisions

**Valhalla, built fresh from the `.pbf`.** The extract shipped with `*.osrm.*`
files, but those are OSRM artifacts and incompatible with Valhalla. Valhalla
builds its own routing tiles, so we built them from `NewYork.osm.pbf` and
ignored the OSRM files.

**`gis-ops/docker-valhalla` image.** It automates the multi-step Valhalla build
pipeline (parse → build tiles → serve) and persists tiles to a mounted volume,
making the setup a single `docker run`.

**Bicycle costing.** Bikesheds are about cycling reachability, so we use
Valhalla's `bicycle` costing profile with default bicycle parameters.

**Both contours in one request.** Valhalla's `/isochrone` accepts multiple
`contours` in a single call, so each station is one request returning both the
11- and 45-minute polygons — fewer requests and both sheds naturally land in the
same file.

**`polygons: true`.** Returns filled polygons (areas) rather than lines, which
is what you want for a coverage/reachability shed.

**`denoise: 0.5`.** Valhalla's `denoise` defaults to `1.0`, which returns only
the single largest contour region. We use `0.5` so that smaller disconnected
regions (e.g. pockets reachable only across a bridge or via a roundabout path)
are kept rather than dropped.

Trade-off: with `denoise` set, one boundary station triggers an internal
Valhalla crash and is **skipped** (see [Scope / limitations](#scope--limitations)).
The same request succeeds with `denoise` omitted, so it's a `denoise`-path edge
case in Valhalla, not a problem with our data.

**`generalize: 50`.** Applies ~50 m Douglas–Peucker simplification to the output
polygons, shrinking file size with negligible loss of fidelity at this scale.

**Concurrency = 8, with retries.** Eight parallel workers saturate the local
service comfortably (~44 stations/sec). Each request retries up to 3 times with
backoff to absorb transient errors.

## Scope / limitations

- **One station is skipped:** `2171903385631266470` (Reservoir Oval E &
  Bainbridge Ave, north Bronx, `40.87634, -73.87902`). With `denoise` set,
  Valhalla returns HTTP 400 with an internal error
  (`vector::_M_range_check ... size 0`) for this location; the request succeeds
  if `denoise` is omitted. So `output/` contains **2,411** of 2,412 stations.
- `stations.json` contains **NYC** stations only. New Jersey Citi Bike stations
  are not in this feed and therefore not in the output, even though the OSM
  extract covers NJ.
- Sheds reflect the **OSM road/path network as of the extract date**
  (`ny_nj_2026-02-17`) and Valhalla's default bicycle costing — not real-time
  conditions, elevation (elevation was disabled), or traffic.

## Files

| Path                    | Description                                          |
|-------------------------|------------------------------------------------------|
| `compute_bikesheds.py`  | Queries Valhalla and writes per-station GeoJSON      |
| `stations.json`         | Citi Bike station feed (input)                       |
| `ny_nj_2026-02-17/`     | OSM extract (`NewYork.osm.pbf` is the input we use)  |
| `valhalla/`             | Valhalla config + built tiles (generated)            |
| `output/`               | Per-station bikeshed GeoJSON (generated)             |

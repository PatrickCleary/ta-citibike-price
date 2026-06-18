#!/usr/bin/env python3
"""Upload bikeshed GeoJSON files to a Supabase Storage bucket.

Reads SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_KEY / service_role) from
.env. Uploads output/*.geojson to <bucket>/<prefix>/<station_id>.geojson with
upsert (overwrite) semantics.
"""
import glob
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

BUCKET = "ta-citibike-price"
PREFIX = "bikesheds"
SRCDIR = "output"
CONTENT_TYPE = "application/geo+json"
WORKERS = 8
RETRIES = 3


def load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    # allow real env to override
    for k in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_KEY",
              "SUPABASE_SERVICE_ROLE_KEY"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = load_env()
URL = ENV.get("SUPABASE_URL", "").rstrip("/")
KEY = (ENV.get("SUPABASE_SERVICE_ROLE_KEY") or ENV.get("SUPABASE_KEY")
       or ENV.get("SUPABASE_ANON_KEY"))
if not URL or not KEY:
    sys.exit("Missing SUPABASE_URL or key in .env / environment")


def upload(path):
    name = os.path.basename(path)
    object_path = f"{PREFIX}/{name}" if PREFIX else name
    endpoint = f"{URL}/storage/v1/object/{BUCKET}/{object_path}"
    body = open(path, "rb").read()
    last = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(endpoint, data=body, method="POST")
            req.add_header("Authorization", f"Bearer {KEY}")
            req.add_header("apikey", KEY)
            req.add_header("Content-Type", CONTENT_TYPE)
            req.add_header("x-upsert", "true")
            req.add_header("cache-control", "3600")
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
            return name, "ok"
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            last = f"HTTP {e.code}: {detail}"
            # auth/permission errors won't fix on retry
            if e.code in (401, 403, 400):
                return name, f"FAIL: {last}"
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # noqa
            last = str(e)
            time.sleep(1.5 * (attempt + 1))
    return name, f"FAIL: {last}"


def main():
    files = sorted(glob.glob(os.path.join(SRCDIR, "*.geojson")))
    only = sys.argv[1:]
    if only:
        files = [f for f in files if os.path.basename(f) in only
                 or f in only][: len(only)] or files[:1]
    total = len(files)
    print(f"Uploading {total} file(s) to {BUCKET}/{PREFIX}/ ...", flush=True)
    done = ok = fail = 0
    failures = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(upload, f): f for f in files}
        for fut in as_completed(futs):
            name, status = fut.result()
            done += 1
            if status == "ok":
                ok += 1
            else:
                fail += 1
                failures.append((name, status))
            if done % 100 == 0 or done == total or (fail and fail <= 3):
                rate = done / (time.time() - t0)
                eta = (total - done) / rate if rate else 0
                print(f"{done}/{total} ok={ok} fail={fail} "
                      f"{rate:.1f}/s ETA {eta:.0f}s", flush=True)
    print(f"\nDONE in {time.time()-t0:.0f}s ok={ok} fail={fail}")
    if failures:
        print("Failures (first 10):")
        for n, m in failures[:10]:
            print(" ", n, m)
        sys.exit(1)


if __name__ == "__main__":
    main()

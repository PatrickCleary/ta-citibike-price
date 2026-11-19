// Prefix a root-relative public asset path with the site's base path, so the
// app works both at a domain root (base "/") and nested under a folder of a
// larger site (PUBLIC_BASE_PATH=/citibike-price, see astro.config.mjs).
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function withBase(path: string): string {
  return `${BASE}${path}`;
}

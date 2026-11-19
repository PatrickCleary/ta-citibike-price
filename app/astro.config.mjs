import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Static output — the whole app is prebuilt files + client-side MapLibre.
//
// PUBLIC_BASE_PATH lets the built site live under a sub-folder of a larger
// site (e.g. /citibike-price). Leave it unset to serve from a domain root.
// Runtime fetches of public/ assets go through withBase() in src/lib/base.ts.
export default defineConfig({
  base: process.env.PUBLIC_BASE_PATH || "/",
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});

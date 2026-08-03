import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The SPA fetches WordPress via /wp-json. In prod it's served by WP (same-origin,
// cookie auth). In dev, proxy /wp-json → local Studio WP so the browser stays
// same-origin (no CORS), forwarding the X-AQ-Dev-User header the localhost shim reads.
const WP = process.env.WP_ORIGIN ?? "http://localhost:8881";
// Dev only: tell the localhost-gated WP shim which user to act as (X-AQ-Dev-User).
// In prod the SPA is same-origin with WP, so the login cookie authenticates instead.
const devUser = process.env.WP_DEV_USER ?? "arashashra";

// Build target: a static bundle the WordPress theme serves itself (WP.com Business
// has no Node runtime). Assets land in the theme's app/ dir and load from the theme
// URL on both local and prod, so `base` is the stable theme path. A manifest lets
// the PHP enqueue resolve the hashed entry filenames.
const THEME_APP_BASE = "/wp-content/themes/artaquest-theme/app/";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  base: command === "build" ? THEME_APP_BASE : "/",
  build: {
    outDir: "../wp-content/themes/artaquest-theme/app",
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    proxy: {
      "/wp-json": {
        target: WP,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (devUser) req.setHeader("X-AQ-Dev-User", devUser);
          });
        },
      },
      // ArtaChat sealed attachments: the client fetches blobs strictly same-origin (the URL inside
      // a sealed message is treated as hostile), so dev must serve the uploads path too.
      // All uploads (chat blobs, notebook deliverables the reader fetches, narration audio) — the
      // SPA reads these same-origin in prod, so dev must serve them through the proxy too.
      "/wp-content/uploads": { target: WP, changeOrigin: true },
    },
  },
}));

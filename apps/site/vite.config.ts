import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// plan 97: the client build (CSS and the one small script) into dist/; the SSR build of src/entry-server.tsx goes
// to .ssr/ (never deployed) and scripts/prerender.mjs writes every page into dist/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { target: "es2022", assetsInlineLimit: 0, modulePreload: false },
  server: { port: Number(process.env.SITE_DEV_PORT ?? 5190), strictPort: false, host: "127.0.0.1" },
});

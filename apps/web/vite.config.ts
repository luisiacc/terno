import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // relative asset URLs so the bundle works from app://unica/ in Electron
  base: "./",
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "src"),
      "@unica/ui": resolve(import.meta.dirname, "../../packages/ui/src"),
    },
  },
  server: { port: 5173, strictPort: true },
  build: {
    target: "chrome140",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("node_modules/react") || id.includes("node_modules/scheduler") ? "react" : undefined),
      },
    },
  },
});

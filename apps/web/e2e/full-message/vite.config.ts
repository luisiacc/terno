import { defineConfig } from "vite";
import app from "../../vite.config";

export default defineConfig(async (env) => {
  const config = typeof app === "function" ? await app(env) : app;
  return { ...config, cacheDir: "/tmp/terno-w11-full-61640/vite", server: { host: "127.0.0.1", port: 61640, strictPort: true, hmr: false } };
});

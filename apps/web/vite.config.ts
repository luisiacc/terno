import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Two targets from one renderer:
 * - desktop (default): the Electron renderer, talking to the utility process (or backend-dev over WebSocket).
 * - web (VITE_TARGET=web): a static site whose backend runs in a dedicated worker on SQLite-WASM/OPFS.
 * The target is a compile-time constant, so the desktop bundle never contains the worker, SQLite-WASM or the web UI.
 */
const target = process.env.VITE_TARGET === "web" ? "web" : "desktop";
const version = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")).version as string;

/** Fails the desktop build if anything from the web host leaks into it. */
function desktopGuard(): Plugin {
  return {
    name: "terno:desktop-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const [name, file] of Object.entries(bundle)) {
        const code = file.type === "chunk" ? file.code : "";
        if (name.endsWith(".wasm") || /installOpfsSAHPoolVfs|sqlite3InitModule|terno-backend-worker/.test(code)) {
          this.error(`the desktop renderer must not ship the web host (${name})`);
        }
      }
    },
  };
}

/**
 * The service worker: precaches the shell, the worker and sqlite3.wasm of
 * this build (its list and build id are injected here), so a repeat visit
 * starts offline and every file comes from one consistent version.
 */
function serviceWorker(buildId: string): Plugin {
  return {
    name: "terno:service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      // SQLite-WASM's own worker and OPFS proxy are emitted but never loaded (the sahpool VFS needs neither)
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && !/sqlite3-(worker1|opfs-async-proxy)/.test(f));
      const source = readFileSync(resolve(import.meta.dirname, "src/web/sw.js"), "utf8")
        .replace("__TERNO_BUILD__", JSON.stringify(buildId))
        .replace("__TERNO_PRECACHE__", JSON.stringify(["./", "theme.js", ...files]));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify({ name: "Terno", short_name: "Terno", start_url: "./", display: "standalone", background_color: "#fcfcfb", theme_color: "#fcfcfb", lang: "es" }),
      });
    },
  };
}

/** CSP for the static site (Electron sets its own on app://). */
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https: cid:",
  "font-src 'self' data:",
  // Gmail and Google sign-in, the AI provider the user configured, and AI on this computer
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
  "frame-src 'self' about: data: https://accounts.google.com/gsi/",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function webHtml(): Plugin {
  return {
    name: "terno:web-html",
    transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_CSP}" />\n    <link rel="manifest" href="./manifest.webmanifest" />`),
  };
}

export default defineConfig(() => {
  const buildId = `${version}-${Date.now().toString(36)}`;
  return {
    // relative asset URLs so the bundle works from app://terno/ in Electron (and from any path on a static host)
    base: "./",
    plugins: [react({ compiler: true }), tailwindcss(), ...(target === "web" ? [serviceWorker(buildId), webHtml()] : [desktopGuard()])],
    define: {
      "import.meta.env.VITE_TARGET": JSON.stringify(target),
      // desktop builds stay reproducible: no timestamp
      "import.meta.env.VITE_BUILD_ID": JSON.stringify(target === "web" ? buildId : version),
      "import.meta.env.VITE_WEB_DEMO": JSON.stringify(process.env.VITE_WEB_DEMO === "1" ? "1" : ""),
    },
    resolve: {
      alias: {
        "~": resolve(import.meta.dirname, "src"),
        "@terno/ui": resolve(import.meta.dirname, "../../packages/ui/src"),
      },
    },
    server: { port: 5173, strictPort: true },
    // SQLite-WASM finds sqlite3.wasm next to its own module
    optimizeDeps: target === "web" ? { exclude: ["@sqlite.org/sqlite-wasm"] } : undefined,
    worker: { format: "es" as const },
    build: {
      target: "chrome140",
      outDir: target === "web" ? "dist-web" : "dist",
      emptyOutDir: true,
      sourcemap: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        output: {
          manualChunks: (id: string) => (id.includes("node_modules/react") || id.includes("node_modules/scheduler") ? "react" : undefined),
        },
      },
    },
  };
});

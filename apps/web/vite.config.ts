import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildDsn } from "../../scripts/release-env.mjs";

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
      // plan 117: Luma's Inter beyond latin and latin-ext (all English and Spanish need) loads only if text asks for it
      const files = Object.keys(bundle).filter((f) => !f.endsWith(".map") && !/sqlite3-(worker1|opfs-async-proxy)/.test(f) && !/(^|\/)inter-(?!latin)[\w-]+\.woff2$/.test(f));
      const source = readFileSync(resolve(import.meta.dirname, "src/web/sw.js"), "utf8")
        .replace("__TERNO_BUILD__", JSON.stringify(buildId))
        .replace("__TERNO_PRECACHE__", JSON.stringify(["./", "theme.js", ...files]));
      // (manifest.webmanifest and the icons are in public/, written by `pnpm brand`)
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/**
 * Source maps are hidden (no sourceMappingURL). The desktop build keeps them
 * in dist/ for scripts/build.mjs, which tags and archives them with the app's
 * own bundles; the web build tags its chunks with debug ids here and moves
 * the maps to .maps/<build id>/ (outside what is deployed). Test builds just
 * drop them.
 */
function webMaps(outDir: string, buildId: string, release: string): Plugin {
  return {
    name: "terno:web-maps",
    apply: "build",
    // closeBundle also runs after a failed build, before there is output to archive.
    async writeBundle() {
      const { archiveMaps, assertNoMaps, injectDebugIds, resetArchive } = await import(resolve(import.meta.dirname, "../../scripts/sourcemaps.mjs"));
      const out = resolve(import.meta.dirname, outDir);
      injectDebugIds(out);
      const archive = resolve(import.meta.dirname, ".maps", outDir === "dist-web" ? buildId : outDir);
      resetArchive(archive);
      archiveMaps(out, archive);
      assertNoMaps(out);
      // what `pnpm upload:web-maps` sends to Sentry: this deployable build's archive and release name
      if (outDir === "dist-web") writeFileSync(resolve(import.meta.dirname, ".maps", "LATEST"), JSON.stringify({ release, archive }));
    },
  };
}

function buildSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: import.meta.dirname }).toString().trim();
  } catch {
    return "unknown";
  }
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

export default defineConfig(({ mode }) => {
  const buildId = `${version}-${Date.now().toString(36)}`;
  const outDir = process.argv.includes("--outDir") ? process.argv[process.argv.indexOf("--outDir") + 1]! : target === "web" ? "dist-web" : "dist";
  return {
    // relative asset URLs so the bundle works from app://terno/ in Electron (and from any path on a static host)
    base: "./",
    plugins: [react({ compiler: true }), tailwindcss(), ...(target === "web" ? [serviceWorker(buildId), webHtml(), webMaps(outDir, buildId, `terno@${version}+${process.env.TERNO_BUILD_SHA || (mode === "production" ? buildSha() : "dev")}`)] : [desktopGuard()])],
    define: {
      "import.meta.env.VITE_TARGET": JSON.stringify(target),
      // desktop builds stay reproducible: no timestamp
      "import.meta.env.VITE_BUILD_ID": JSON.stringify(target === "web" ? buildId : version),
      "import.meta.env.VITE_WEB_DEMO": JSON.stringify(process.env.VITE_WEB_DEMO === "1" ? "1" : ""),
      "import.meta.env.VITE_BUILD_SHA": JSON.stringify(process.env.TERNO_BUILD_SHA || (mode === "production" ? buildSha() : "dev")),
      // the web reports from the page (plan 78: a release gets Terno's DSN, a demo or test build none unless
      // TERNO_SENTRY_DSN says so); the desktop renderer never does (main sends)
      "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(target === "web" ? buildDsn() : ""),
      // plan 99: the web build's own Google client (public); from the environment only, so e2e builds keep bring-your-own
      "import.meta.env.VITE_TERNO_GOOGLE_CLIENT_ID": JSON.stringify(target === "web" ? (process.env.TERNO_RELEASE === "1" ? process.env.TERNO_GOOGLE_WEB_ID : process.env.TERNO_GOOGLE_WEB_DEV_ID) ?? "" : ""),
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
      sourcemap: "hidden" as const,
      modulePreload: { polyfill: false },
      rollupOptions: {
        // plan 92: the icon barrel and its per-icon modules have no side effects, so each icon lands in the chunk that
        // uses it (a composer-only icon in the lazy composer) instead of riding the barrel into the entry
        treeshake: { moduleSideEffects: (id: string) => (/packages\/ui\/src\/(icons\.ts|iconset\/)/.test(id) ? false : undefined) },
        output: {
          // React itself, not every package whose name starts with "react" (react-aria-components and react-day-picker
          // belong to the lazy pickers that import them, plan 122)
          manualChunks: (id: string) => (/[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id) ? "react" : undefined),
        },
      },
    },
  };
});

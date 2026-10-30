import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

export default defineConfig((env) => mergeConfig(base(env), {
  plugins: [{
    name: "w11-test-worker-timers",
    apply: "serve",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/web/worker/backend.worker.ts")) return;
      return `import "/e2e-web/queued-work/timer-probe.js";\n${code}`;
    },
  }],
}));

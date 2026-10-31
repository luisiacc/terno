import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

export default defineConfig((env) => mergeConfig(base(env), {
  plugins: [{
    name: "w05-test-close-witness",
    apply: "serve",
    enforce: "pre",
    transform(code: string, id: string) {
      if (!id.endsWith("/src/web/connect.ts")) return;
      const marker = /let stopped = (?:false|!1);/;
      if (!marker.test(code)) throw new Error(`Web worker close witness insertion point changed: ${code.slice(Math.max(0, code.indexOf("stopped") - 80), code.indexOf("stopped") + 120)}`);
      return code.replace(marker, `let stopped = false;\n  worker.addEventListener("message", (event) => {\n    if (event.data?.type === "closed") window.dispatchEvent(new Event("w05-worker-closed"));\n  });`);
    },
  }],
}));

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("../../src/", import.meta.url)) }] },
  test: {
    include: ["apps/web/e2e/full-message/*.unit.ts", "apps/web/src/lib/cid-mime.test.tsx", "apps/web/src/lib/mail.test.ts", "apps/web/src/lib/remote-consent.test.ts", "apps/web/src/lib/page.test.ts"],
    environment: "jsdom",
  },
});

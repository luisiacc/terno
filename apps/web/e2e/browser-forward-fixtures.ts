import { test as base } from "./fixtures";
export * from "./fixtures";
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/*", (route) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await use(page);
  },
});

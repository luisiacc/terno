import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([undefined, "57530"])("the dev print server and browser share the isolated port (%s)", async (port) => {
  vi.stubEnv("E2E_PORT", port);
  // Keep the development runner config outside the renderer TypeScript project.
  const module = "../../playwright.print.dev.config";
  const { default: config } = await import(module);
  const server = config.webServer as { command: string; url: string };
  expect(config.use?.baseURL).toBe(server.url);
  expect(server.command).toContain(`--port ${port ?? "57510"} --strictPort`);
});

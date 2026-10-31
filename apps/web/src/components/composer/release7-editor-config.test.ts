import type { PlaywrightTestConfig } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "59110", "59120"])("keeps the focused navigation and server URLs aligned with E2E_PORT=%s", async port => {
  vi.stubEnv("E2E_PORT", port);
  vi.resetModules();
  const { default: config } = await vi.importActual<{ default: PlaywrightTestConfig }>("../../../playwright.release7-editor.config");
  const server = config.webServer;
  expect(server && !Array.isArray(server) && server.url).toBe(`http://127.0.0.1:${port ?? "59110"}`);
  expect(config.use?.baseURL).toBe(`http://127.0.0.1:${port ?? "59110"}`);
});

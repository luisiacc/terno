import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([undefined, "56360"])("uses the same renderer admission server and browser port (%s)", async (port) => {
  vi.stubEnv("E2E_PORT", port);
  vi.resetModules();
  const configPath = "../../playwright.renderer-admission.config";
  const { default: config } = await import(configPath);
  const address = `http://127.0.0.1:${port ?? 56240}`;
  expect(config.use?.baseURL).toBe(address);
  expect(config.webServer).toMatchObject({ url: address });
});

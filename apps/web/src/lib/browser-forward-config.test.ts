import { expect, it } from "vitest";

it("keeps the browser wire development config out of production/performance discovery", async () => {
  const configPath = "../../playwright.browser-forward.config";
  const { default: config } = await import(configPath);
  expect(config.projects?.map((project: { name: string }) => project.name)).toEqual(["e2e"]);
  expect(config.testMatch).toEqual(["gmail-wire.spec.ts", "reply-subject.spec.ts"]);
  expect(config.globalSetup).toBe("./e2e/reply-identity.setup.ts");
  expect(config.webServer.command).not.toMatch(/\bbuild\b|\bpreview\b/);
  expect(config.webServer.url).toBe(config.use.baseURL);
});

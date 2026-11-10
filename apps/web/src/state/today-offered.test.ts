// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { installToday, useToday } = await import("./today");
installToday();
const { getApp, setApp } = await import("./app");

const keys = { anthropic: true, openai: false, jev: false };
const ai = { provider: "ollama", model: "m", local: true, needsKey: false, keys: {} };
const settings = (devAi: boolean) => ({ ai, devAi, today: { show: true } }) as never;

describe("Today with Dev mode's switch off (plan 147)", () => {
  beforeEach(() => {
    setApp({ devAi: keys, settings: settings(true), today: false });
    useToday.setState({ fromDigest: null });
  });

  it("a way back to the digest goes with it, though Today's list wasn't on screen", () => {
    useToday.setState({ fromDigest: 7 });
    setApp({ settings: settings(false) });
    expect(useToday.getState().fromDigest).toBe(null);
  });

  it("whatever brings Today back while it's hidden (a preview's Cancel) leaves again", () => {
    setApp({ settings: settings(false) });
    setApp({ today: true });
    expect(getApp().today).toBe(false);
  });

  it("the switch on, it stays; and nothing happens while settings are still being read", () => {
    setApp({ today: true });
    expect(getApp().today).toBe(true);
    setApp({ settings: null, today: true });
    expect(getApp().today).toBe(true);
  });
});

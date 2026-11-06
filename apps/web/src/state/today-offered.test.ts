// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { useToday } = await import("./today");
const { getApp, setApp } = await import("./app");

const keys = { anthropic: true, openai: false, jev: false };
const ai = { provider: "ollama", model: "m", local: true, needsKey: false, tasks: {}, keys: {} };
const settings = (devAi: boolean) => ({ ai, devAi, today: { show: true } }) as never;

describe("Today with Dev mode's switch off (plan 147)", () => {
  beforeEach(() => {
    setApp({ devAi: keys, settings: settings(true), today: false });
    useToday.setState({ fromDigest: false });
  });

  it("a way back to the digest goes with it, though Today's list wasn't on screen", () => {
    useToday.setState({ fromDigest: true });
    setApp({ settings: settings(false) });
    expect(useToday.getState().fromDigest).toBe(false);
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

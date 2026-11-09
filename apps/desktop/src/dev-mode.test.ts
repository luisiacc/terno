import { describe, expect, it } from "vitest";
import { backendEnv, devModeOf, takeDevAiEnv } from "./dev-mode";

describe("devModeOf (plan 146)", () => {
  it("is only a local run on the dev server", () => {
    expect(devModeOf({ devUrl: "http://localhost:5173", packaged: false })).toBe(true);
    expect(devModeOf({ devUrl: undefined, packaged: false })).toBe(false);
    expect(devModeOf({ devUrl: "http://localhost:5173", packaged: true })).toBe(false);
  });

  it("plan 161: main keeps no key: they're taken from its environment, and only the backend gets them, in Dev mode", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key", JEV_API_KEY: "", GROQ_API_KEY: "g" };
    const keys = takeDevAiEnv(env);
    expect(keys).toEqual({ ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key" });
    // what main (and all it spawns) still has
    expect(env).toEqual({ PATH: "/bin", GROQ_API_KEY: "g" });
    expect(backendEnv(env, keys, true)).toEqual({ PATH: "/bin", GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key" });
    expect(backendEnv(env, keys, false)).toEqual({ PATH: "/bin", GROQ_API_KEY: "g" });
  });
});

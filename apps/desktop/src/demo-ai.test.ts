import { describe, expect, it } from "vitest";
import { DEMO_AI_NOW, DEMO_AI_STEPS, demoAiArgs, demoAiClock, demoAiEnv, demoAiProfileProblem, devKeysIn, keyFiles, MARKER_VERSION, missingKeysMessage, readMarker, resolveKeys, stepsToRun } from "./demo-ai";

describe("plan 167: pnpm dev:demo-ai", () => {
  it("takes --fresh (and dev.mjs's --cleandb), and refuses anything else so a typo isn't a silent no-op", () => {
    expect(demoAiArgs(["node", "dev.mjs", "--demo-ai"])).toEqual({ fresh: false });
    expect(demoAiArgs(["node", "dev.mjs", "--demo-ai", "--fresh"])).toEqual({ fresh: true });
    expect(demoAiArgs(["node", "dev.mjs", "--demo-ai", "--cleandb"])).toEqual({ fresh: true });
    expect(() => demoAiArgs(["node", "dev.mjs", "--demo-ai", "--frsh"])).toThrow(/--frsh.*--fresh/);
  });

  it("looks for keys in this checkout's .env, then the main checkout's (a worktree has none)", () => {
    expect(keyFiles("/w/t3-1", "/repo/.git")).toEqual(["/w/t3-1/.env", "/repo/.env"]);
    // in the main checkout, git's common dir is its own .git: one file
    expect(keyFiles("/repo", ".git")).toEqual(["/repo/.env"]);
    expect(keyFiles("/repo", null)).toEqual(["/repo/.env"]);
  });

  it("reads only Dev mode's three names from a .env", () => {
    const text = 'SENTRY_AUTH_TOKEN=s3cret\nexport ANTHROPIC_API_KEY="a-1"\nOPENAI_API_KEY = o-1 \nJEV_API_KEY=\nGROQ_API_KEY=g\n# OPENAI_API_KEY=old';
    expect(devKeysIn(text)).toEqual({ ANTHROPIC_API_KEY: "a-1", OPENAI_API_KEY: "o-1" });
  });

  it("the shell wins, then each file fills what's missing; it says where each came from and what's missing", () => {
    const files = [{ path: "/w/.env", text: null }, { path: "/repo/.env", text: "ANTHROPIC_API_KEY=a-file\nOPENAI_API_KEY=o-file\nJEV_API_KEY=j-file" }];
    const r = resolveKeys({ ANTHROPIC_API_KEY: "a-shell", PATH: "/bin" }, files);
    expect(r.keys).toEqual({ ANTHROPIC_API_KEY: "a-shell", OPENAI_API_KEY: "o-file", JEV_API_KEY: "j-file" });
    expect(r.from).toEqual({ ANTHROPIC_API_KEY: "the shell", OPENAI_API_KEY: "/repo/.env", JEV_API_KEY: "/repo/.env" });
    expect(r.missing).toEqual([]);
    // JEV is optional; the two Pro runs on aren't
    expect(resolveKeys({}, [{ path: "/r/.env", text: "JEV_API_KEY=j" }]).missing).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  it("a missing key is named with the places looked, never with a value", () => {
    const message = missingKeysMessage(["OPENAI_API_KEY"], ["/w/.env", "/repo/.env"]);
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("/repo/.env");
    expect(message).not.toMatch(/a-shell|o-file/);
  });

  it("Electron's environment: the demo mailbox, the fixed clock, UTC, the keys; behind your windows only to prepare", () => {
    const base = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", TERNO_TEST_DEV_AI: "1", TERNO_TEST_NET_LOG: "/tmp/x", OPENAI_API_KEY: "stale", TERNO_TEST_NOW: "1" };
    const window = demoAiEnv({ base, profile: "/p", keys: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }, devUrl: "http://localhost:5199/", background: false });
    expect(window).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", TERNO_DEMO: "1", TERNO_USER_DATA: "/p", TERNO_DEV_URL: "http://localhost:5199/", TERNO_TEST_NOW: String(DEMO_AI_NOW), TZ: "UTC" });
    expect(new Date(DEMO_AI_NOW).toISOString()).toBe("2026-10-22T16:00:00.000Z");
    expect(demoAiEnv({ base, profile: "/p", keys: {}, devUrl: "http://x/", background: true }).TERNO_TEST_BACKGROUND).toBe("1");
    // a scripted check that mustn't take focus asks for it from the shell
    expect(demoAiEnv({ base: { TERNO_TEST_BACKGROUND: "1" }, profile: "/p", keys: {}, devUrl: "http://x/", background: false }).TERNO_TEST_BACKGROUND).toBe("1");
    // after the preparation the clock starts where it ended
    expect(demoAiEnv({ base, profile: "/p", keys: {}, devUrl: "http://x/", background: false, now: DEMO_AI_NOW + 90_000 }).TERNO_TEST_NOW).toBe(String(DEMO_AI_NOW + 90_000));
  });

  it("which steps a launch runs: all the first time and with --fresh, the missing ones after a failure, none once done", () => {
    const all = [...DEMO_AI_STEPS];
    expect(stepsToRun(null, { fresh: false })).toEqual(all);
    const done = Object.fromEntries(all.map((s) => [s, "2026-11-09T00:00:00Z"]));
    const marker = { version: MARKER_VERSION, done };
    expect(stepsToRun(marker, { fresh: false })).toEqual([]);
    expect(stepsToRun(marker, { fresh: true })).toEqual(all);
    const { ask: _, rule: __, ...partial } = done;
    expect(stepsToRun({ version: MARKER_VERSION, done: partial, failed: { ask: "timeout" } }, { fresh: false })).toEqual(["ask", "rule"]);
  });

  it("a marker that's unreadable or from another version starts over", () => {
    expect(readMarker(null)).toBeNull();
    expect(readMarker("{oops")).toBeNull();
    expect(readMarker(JSON.stringify({ version: MARKER_VERSION + 1, done: {} }))).toBeNull();
    expect(readMarker(JSON.stringify({ version: MARKER_VERSION, done: { "ai-on": "x" } }))).toEqual({ version: MARKER_VERSION, done: { "ai-on": "x" } });
  });

  it("later launches start where the preparation ended, never before 16:00", () => {
    expect(demoAiClock(null)).toBe(DEMO_AI_NOW);
    expect(demoAiClock({ version: MARKER_VERSION, done: {}, clock: DEMO_AI_NOW + 150_000 })).toBe(DEMO_AI_NOW + 150_000);
    expect(demoAiClock({ version: MARKER_VERSION, done: {}, clock: 5 })).toBe(DEMO_AI_NOW);
  });

  it("TERNO_USER_DATA never lands it on a mailbox that isn't this demo's, nor on a real profile", () => {
    expect(demoAiProfileProblem({ path: "/Users/x/Library/Application Support/Terno-dev-demo-ai", hasDb: false, hasMarker: false })).toBeNull();
    expect(demoAiProfileProblem({ path: "/tmp/demo/profile", hasDb: true, hasMarker: true })).toBeNull();
    expect(demoAiProfileProblem({ path: "/Users/x/Library/Application Support/Terno-dev-demo", hasDb: true, hasMarker: false })).toMatch(/isn't the AI demo's/);
    expect(demoAiProfileProblem({ path: "/Users/x/Library/Application Support/Terno", hasDb: false, hasMarker: false })).toMatch(/real Terno profile/);
    expect(demoAiProfileProblem({ path: "/Users/x/Library/Application Support/Terno-beta/", hasDb: false, hasMarker: true })).toMatch(/real Terno profile/);
  });
});

import { describe, expect, it } from "vitest";
import { askFinished, conversationDone, replyOutcome, replyStillComing, DEMO_AI_NOW, DEMO_AI_STEPS, demoAiArgs, demoAiClock, demoAiEnv, demoAiProfileProblem, MAX_ATTEMPTS, partialVerdict, devKeysIn, keyFiles, MARKER_VERSION, missingKeysMessage, readMarker, resolveKeys, stepsToRun } from "./demo-ai";

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
    const preparing = demoAiEnv({ base: { ...base, TERNO_TEST_LANGUAGES: "es-MX" }, profile: "/p", keys: {}, devUrl: "http://x/", background: true });
    expect(preparing.TERNO_TEST_BACKGROUND).toBe("1");
    // the preparation reads the app's English words whatever the Mac's language; your window keeps the Mac's
    expect(preparing.TERNO_TEST_LANGUAGES).toBe("en-US");
    expect(demoAiEnv({ base: { TERNO_TEST_LANGUAGES: "es-MX" }, profile: "/p", keys: {}, devUrl: "http://x/", background: false }).TERNO_TEST_LANGUAGES).toBeUndefined();
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

  it("TERNO_USER_DATA never lands it on anything that isn't this demo's, nor on a real profile", () => {
    const ok = (path: string, entries: string[] | null) => demoAiProfileProblem({ path, entries });
    expect(ok("/Users/x/Library/Application Support/Terno-dev-demo-ai", null)).toBeNull();
    expect(ok("/tmp/new", [".DS_Store"])).toBeNull();
    expect(ok("/tmp/demo/profile", ["terno.db", "demo-ai.json"])).toBeNull();
    // another dev profile, a legacy database, Application Support itself: something there, no marker of ours
    expect(ok("/Users/x/Library/Application Support/Terno-dev-demo", ["terno.db"])).toMatch(/isn't the AI demo's/);
    expect(ok("/tmp/old", ["unica.db"])).toMatch(/isn't the AI demo's/);
    expect(ok("/Users/x/Library/Application Support", ["Terno", "Terno-dev-demo"])).toMatch(/isn't the AI demo's/);
    expect(ok("/Users/x/Library/Application Support/Terno", null)).toMatch(/real Terno profile/);
    expect(ok("/Users/x/Library/Application Support/Unica/", null)).toMatch(/real Terno profile/);
    expect(ok("/Users/x/Library/Application Support/Terno-beta/", ["demo-ai.json"])).toMatch(/real Terno profile/);
    // outside Application Support the name says nothing (run.sh's /tmp/terno-demo-ai); the contents still decide
    expect(ok("/tmp/terno-demo-ai", null)).toBeNull();
    expect(ok("/tmp/Terno", ["demo-ai.json", "terno.db"])).toBeNull();
    expect(ok("/tmp/terno-demo-ai", ["terno.db"])).toMatch(/isn't the AI demo's/);
  });

  it("a question counts only once every turn finished with an answer of some kind", () => {
    expect(askFinished(["answered"])).toBe(true);
    expect(askFinished(["partial", "not_found"])).toBe(true);
    expect(askFinished(["answered", "failed"])).toBe(false);
    expect(askFinished(["stopped"])).toBe(false);
    expect(askFinished([null])).toBe(false);
    expect(askFinished([])).toBe(false);
  });

  it("a conversation is done with its summary and its reply settled; an error or an unfinished reply waits for the next launch", () => {
    expect(conversationDone({ summary: "ready", reply: "ready" })).toBe(true);
    // the model decided no reply was needed: done
    expect(conversationDone({ summary: "ready", reply: "none" })).toBe(true);
    expect(conversationDone({ summary: "none", reply: "ready" })).toBe(true);
    expect(conversationDone({ summary: "error", reply: "ready" })).toBe(false);
    expect(conversationDone({ summary: "timeout", reply: "none" })).toBe(false);
    expect(conversationDone({ summary: "ready", reply: "unfinished" })).toBe(false);
  });

  it("Reply ready is settled by what the app stored, not by the card's absence", () => {
    const now = DEMO_AI_NOW;
    const day = 86_400_000;
    expect(replyOutcome({ cardReady: true, stored: null, waitingSince: now - day, now })).toBe("ready");
    expect(replyOutcome({ cardReady: false, stored: "ready", waitingSince: now - day, now })).toBe("ready");
    // the model said no reply is needed: settled
    expect(replyOutcome({ cardReady: false, stored: "skipped", waitingSince: now - day, now })).toBe("none");
    expect(replyOutcome({ cardReady: false, stored: "failed", waitingSince: now - day, now })).toBe("unfinished");
    // no row yet on a conversation that waits for a reply: the model may still be deciding
    expect(replyOutcome({ cardReady: false, stored: null, waitingSince: now - day, now })).toBe("unfinished");
    // no row because nothing is owed, or the wait is past Reply ready's 30 days
    expect(replyOutcome({ cardReady: false, stored: null, waitingSince: null, now })).toBe("none");
    expect(replyOutcome({ cardReady: false, stored: null, waitingSince: now - 31 * day, now })).toBe("none");
  });

  it("the settle waits only for a reply that was writing when its conversation was left", () => {
    const o = { reply: "unfinished" as const, stored: null, waited: 1000, limit: 180_000 };
    expect(replyStillComing({ ...o, writing: true })).toBe(true);
    // left before its first words: leaving stopped it, and nothing more will be stored (Codex review)
    expect(replyStillComing({ ...o, writing: false })).toBe(false);
    expect(replyStillComing({ ...o, writing: true, stored: "failed" })).toBe(false);
    expect(replyStillComing({ ...o, writing: true, waited: 180_001 })).toBe(false);
    expect(replyStillComing({ ...o, writing: true, reply: "ready" })).toBe(false);
    expect(replyStillComing({ ...o, writing: true, reply: "none" })).toBe(false);
  });

  it("a step with something missing runs again, and after MAX_ATTEMPTS keeps what's there", () => {
    expect(partialVerdict([], 1)).toBe("done");
    expect(partialVerdict(["a"], 1)).toBe("again");
    expect(partialVerdict(["a"], MAX_ATTEMPTS - 1)).toBe("again");
    expect(partialVerdict(["a"], MAX_ATTEMPTS)).toBe("keep");
  });
});

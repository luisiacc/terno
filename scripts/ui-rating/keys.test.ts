import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_ANTHROPIC_MODEL, PROVIDERS as AI_PROVIDERS } from "../../packages/ai/src/providers";
import { ASK_CLAUDE_MODEL, ASK_PLAN_CLAUDE_MODEL, DEV_AI_ENV, DIGEST_CLAUDE_MODEL, FOLLOWUP_CLAUDE_MODEL, INTENT_CLAUDE_MODEL, JEV_DEFAULT_MODEL, REPLY_CHECK_CLAUDE_MODEL, SUMMARY_DEFAULT_MODEL, WRITING_CLAUDE_MODEL } from "../../packages/core/src/ai";
import { electronEnv } from "./harness.mjs";
import { copyRedacted, envFile, filesHoldingKeys, PRO_ROUTING, PROVIDERS, readKeys, redact, REDACTED } from "./keys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync("/tmp/rating-keys-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// invented, shaped like the real ones so the shape rules are exercised too
const FAKE = {
  ANTHROPIC_API_KEY: "sk-ant-api03-FAKEanthropicKEYforTHEratingTEST0123456789",
  OPENAI_API_KEY: "sk-proj-FAKEopenaiKEYforTHEratingTEST0123456789abcdef",
  JEV_API_KEY: "jev_FAKEjevKEYforTHEratingTEST0123",
  GROQ_API_KEY: "gsk_FAKEgroqKEYforTHEratingTEST0123456789",
};
const fakeEnv = (vars: Record<string, string>, name = `${Math.random()}.env`) => {
  const file = join(dir, name);
  writeFileSync(file, `# the owner's file\nSENTRY_AUTH_TOKEN=unrelated\n${Object.entries(vars).map(([k, v], i) => (i % 2 ? `export ${k}="${v}"` : `${k}=${v}`)).join("\n")}\n`);
  return file;
};

describe("plan 161: the AI rating's keys", () => {
  it("come from one file, the owner's .env by default or the one TERNO_RATING_ENV names", () => {
    expect(envFile({})).toBe("/Users/Luis/projects/emailclient/.env");
    expect(envFile({ TERNO_RATING_ENV: "/elsewhere/.env" })).toBe("/elsewhere/.env");
  });

  it("only Pro's three are read: nothing else in the file, not Groq's, not the rest", () => {
    const keys = readKeys(fakeEnv(FAKE));
    expect(keys.env).toEqual({ ANTHROPIC_API_KEY: FAKE.ANTHROPIC_API_KEY, OPENAI_API_KEY: FAKE.OPENAI_API_KEY, JEV_API_KEY: FAKE.JEV_API_KEY });
    expect(keys.providers).toEqual(["anthropic", "openai", "jev"]);
    expect(keys.hosts).toEqual(["api.anthropic.com", "api.openai.com", "api.typesafe.ai"]);
    // JEV is optional (smart categories, off in the demo)
    const { JEV_API_KEY: _j, ...noJev } = FAKE;
    expect(readKeys(fakeEnv(noJev)).providers).toEqual(["anthropic", "openai"]);
  });

  it("a missing file or key names the file and the variable, never a value", () => {
    expect(() => readKeys(join(dir, "none.env"))).toThrow(`no file at ${join(dir, "none.env")}`);
    const { OPENAI_API_KEY: _o, ...noOpenai } = FAKE;
    const file = fakeEnv(noOpenai);
    let message = "";
    try { readKeys(file); } catch (e) { message = (e as Error).message; }
    expect(message).toBe(`${file} has no OPENAI_API_KEY: the AI rating needs it`);
    for (const v of Object.values(FAKE)) expect(message).not.toContain(v);
  });

  it("are Pro's providers and hosts as the app has them (plan 146's DEV_AI_ENV, @terno/ai's endpoints)", () => {
    expect(Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.env]))).toEqual(DEV_AI_ENV);
    for (const [id, p] of Object.entries(PROVIDERS)) expect(new URL(AI_PROVIDERS.find((d) => d.id === id)!.defaultBaseURL!).hostname).toBe(p.host);
  });

  it("the routing round.json records is the app's own (AiService.targetFor over Dev mode's overlay)", () => {
    expect(PRO_ROUTING).toEqual({
      summary: `openai/${SUMMARY_DEFAULT_MODEL}`,
      writing: `anthropic/${WRITING_CLAUDE_MODEL}`,
      reply: `anthropic/${WRITING_CLAUDE_MODEL}`,
      replyCheck: `anthropic/${REPLY_CHECK_CLAUDE_MODEL}`,
      ask: `anthropic/${ASK_CLAUDE_MODEL}`,
      askPlan: `anthropic/${ASK_PLAN_CLAUDE_MODEL}`,
      followup: `anthropic/${FOLLOWUP_CLAUDE_MODEL}`,
      digest: `anthropic/${DIGEST_CLAUDE_MODEL}`,
      filter: `anthropic/${DEFAULT_ANTHROPIC_MODEL}`,
      intent: `anthropic/${INTENT_CLAUDE_MODEL}`,
      voice: `anthropic/${WRITING_CLAUDE_MODEL}`,
      categorize: `jev/${JEV_DEFAULT_MODEL}`,
    });
  });
});

describe("plan 161: Electron's environment", () => {
  const keys = readKeys(fakeEnv(FAKE));
  const caller = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", TERNO_DEV_URL: "http://localhost:5173", ...FAKE, TERNO_TEST_DEV_AI: "1", TERNO_RATING_ENV: "/x/.env" };

  it("real models: the file's three keys and Dev mode's switch, only in the env handed to Electron", () => {
    const env = electronEnv({ base: caller, profile: "/p", log: "/p/net.log", mode: "real", keys });
    expect(env).toMatchObject({ ...keys.env, TERNO_TEST_DEV_AI: "1", TERNO_DEMO: "1", TERNO_TEST_NET_LOG: "/p/net.log", TZ: "UTC" });
    for (const k of ["GROQ_API_KEY", "ELECTRON_RUN_AS_NODE", "TERNO_DEV_URL", "TERNO_RATING_ENV"]) expect(env).not.toHaveProperty(k);
  });

  it("the stub and AI off: no key at all, even one the caller had, and no Dev mode", () => {
    for (const mode of ["stub", null]) {
      const env = electronEnv({ base: caller, profile: "/p", log: "/p/net.log", mode, keys: null });
      for (const k of [...Object.keys(FAKE), "TERNO_TEST_DEV_AI"]) expect(env).not.toHaveProperty(k);
    }
    expect(electronEnv({ base: caller, profile: "/p", log: "/l", mode: null, keys: null })).not.toHaveProperty("TERNO_TEST_NET_LOG");
  });
});

describe("plan 161: redaction", () => {
  it("replaces every loaded key, and anything shaped like a provider's key", () => {
    const keys = Object.values(FAKE);
    expect(redact(`a ${FAKE.JEV_API_KEY} b ${FAKE.OPENAI_API_KEY}`, keys)).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(redact("sk-ant-api03-SOMEotherKEYnobodyLOADED0000", [])).toBe(REDACTED);
    expect(redact("gsk_SOMEotherGROQkeyNOBODYloaded000000", [])).toBe(REDACTED);
    // what isn't a key stays: ids, hosts, the masked hint a provider gives back
    for (const text of ["api.openai.com", "claude-sonnet-5-5", "sk-proj-****abcd", "a01-summary-light.png"]) expect(redact(text, keys)).toBe(text);
  });

  it("copies a room's files out with text redacted and images as they are", () => {
    const room = join(dir, "room");
    mkdirSync(join(room, "probes"), { recursive: true });
    writeFileSync(join(room, "report.md"), `I read ${FAKE.ANTHROPIC_API_KEY}`);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    writeFileSync(join(room, "probes", "x.png"), png);
    copyRedacted(room, join(dir, "room-out"), Object.values(FAKE));
    expect(readFileSync(join(dir, "room-out", "report.md"), "utf8")).toBe(`I read ${REDACTED}`);
    expect(readFileSync(join(dir, "room-out", "probes", "x.png"))).toEqual(png);
    expect(filesHoldingKeys(join(dir, "room-out"), Object.values(FAKE))).toEqual([]);
    expect(filesHoldingKeys(room, Object.values(FAKE))).toEqual([join(room, "report.md")]);
  });

  it("checks every file leaving the room, whatever it's called (Codex review: an .env, .jsonl or .har probe)", () => {
    const room = join(dir, "room-odd");
    mkdirSync(room, { recursive: true });
    for (const name of ["debug.env", "requests.jsonl", "trace.har", "noext"]) writeFileSync(join(room, name), `key=${FAKE.JEV_API_KEY}\n`);
    writeFileSync(join(room, "shaped.bin"), "sk-ant-api03-ANOTHERkeyNOBODYloaded0000");
    copyRedacted(room, join(dir, "room-odd-out"), Object.values(FAKE));
    expect(filesHoldingKeys(join(dir, "room-odd-out"), Object.values(FAKE))).toEqual([]);
    expect(readFileSync(join(dir, "room-odd-out", "debug.env"), "utf8")).toBe(`key=${REDACTED}\n`);
    expect(readFileSync(join(dir, "room-odd-out", "shaped.bin"), "utf8")).toBe(REDACTED);
  });

  it("a fake key in a fake .env never reaches stdout, stderr or any file a run writes", () => {
    const run = mkdtempSync(join(dir, "run-"));
    const file = fakeEnv(FAKE, "run.env");
    const out = join(run, "out");
    // a run that tries every way out it has: console, raw writes, a buffer, a thrown error, the round's logs and a room's files
    const script = join(run, "leaky.mjs");
    writeFileSync(script, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { copyRedacted, envFile, guardOutput, readKeys, writeRedacted } from ${JSON.stringify(join(here, "keys.mjs"))};
      import { electronEnv } from ${JSON.stringify(join(here, "harness.mjs"))};
      const keys = readKeys(envFile());
      guardOutput(keys.secrets);
      const env = electronEnv({ base: {}, profile: "/p", log: "/p/net.log", mode: "real", keys });
      const all = Object.values(keys.env).join(" ");
      mkdirSync(${JSON.stringify(out)}, { recursive: true });
      console.log("log", all, JSON.stringify(env));
      console.error("error", all);
      process.stdout.write(Buffer.from("buffer " + all + "\\n"));
      process.stderr.write("raw " + all + "\\n");
      writeRedacted(join(${JSON.stringify(out)}, "capture-lumen.log"), "capture " + all, keys.secrets);
      writeRedacted(join(${JSON.stringify(out)}, "round.json"), JSON.stringify({ ai: { env } }), keys.secrets);
      const room = join(${JSON.stringify(run)}, "room");
      mkdirSync(join(room, "probes"), { recursive: true });
      writeFileSync(join(room, "report.json"), JSON.stringify({ why: all }));
      writeFileSync(join(room, "probes", "notes.txt"), all);
      copyRedacted(join(room, "probes"), join(${JSON.stringify(out)}, "claude-probes"), keys.secrets);
      copyRedacted(join(room, "report.json"), join(${JSON.stringify(out)}, "claude.json"), keys.secrets);
      try { throw new Error("thrown " + all); } catch (e) { console.error(e.stack); }
    `);
    const child = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, TERNO_RATING_ENV: file }, encoding: "utf8" });
    expect(child.status).toBe(0);
    const secrets = [FAKE.ANTHROPIC_API_KEY, FAKE.OPENAI_API_KEY, FAKE.JEV_API_KEY];
    // the run did print and write: each place carries the redaction mark, never a key
    for (const text of [child.stdout, child.stderr]) {
      expect(text).toContain(REDACTED);
      for (const s of [...secrets, FAKE.GROQ_API_KEY]) expect(text).not.toContain(s);
    }
    const written = readdirSync(out, { recursive: true }).map(String).filter((f) => statSync(join(out, f)).isFile());
    expect(written.sort()).toEqual(["capture-lumen.log", "claude-probes/notes.txt", "claude.json", "round.json"]);
    expect(filesHoldingKeys(out, [...secrets, FAKE.GROQ_API_KEY])).toEqual([]);
  });

  it("capture.mjs, failing on a .env without a key, says which and prints none of the others", () => {
    const { OPENAI_API_KEY: _o, ...noOpenai } = FAKE;
    const file = fakeEnv(noOpenai, "capture.env");
    const out = mkdtempSync(join(dir, "capture-"));
    const child = spawnSync(process.execPath, [join(here, "capture.mjs"), "lumen", out, "light", "--screens", "ai"], { env: { PATH: process.env.PATH, TERNO_RATING_ENV: file }, encoding: "utf8" });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(`${file} has no OPENAI_API_KEY`);
    for (const s of Object.values(FAKE)) expect(child.stdout + child.stderr).not.toContain(s);
    expect(execFileSync("ls", ["-A", out]).toString()).toBe("");
  });
});

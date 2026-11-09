import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aiMode, netProblems } from "./harness.mjs";
import { briefFor } from "./sets.mjs";

const dir = mkdtempSync("/tmp/net-check-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = (lines: object[]) => {
  const file = join(dir, `${Math.random()}.log`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
};

describe("the AI capture's network check (plan 161, revision 10)", () => {
  it("passes when every AI request went to the stub and nothing left loopback; a refused icon is no request", () => {
    const file = log([
      { purpose: "ai", url: "http://127.0.0.1:4100/v1/chat/completions", allowed: true },
      { purpose: "ai", url: "http://localhost:4100/api/tags", allowed: true },
      { purpose: "icons", url: "https://example.com/favicon.ico", allowed: false },
    ]);
    expect(netProblems({ log: file, blocked: [], stubPort: 4100 })).toEqual({ problems: [], decisions: 3, ai: 2, hosts: [] });
  });

  it("names an AI request anywhere but the stub, anything off loopback, and what the window's fence refused", () => {
    const file = log([
      { purpose: "ai", url: "http://127.0.0.1:11434/api/tags", allowed: true },
      { purpose: "ai", url: "https://api.openai.com/v1/chat/completions", allowed: true },
      { purpose: "update", url: "https://updates.terno.app/feed", allowed: true },
    ]);
    expect(netProblems({ log: file, blocked: ["https://img.example/pixel.gif"], stubPort: 4100 }).problems).toEqual([
      "the window asked for https://img.example/pixel.gif",
      "an AI request went to 127.0.0.1:11434, not the stub",
      "the backend reached api.openai.com (ai)",
      "the backend reached updates.terno.app (update)",
    ]);
  });

  it("no log, or a log cut at its bound, is no proof", () => {
    expect(netProblems({ log: join(dir, "never-written.log"), blocked: [], stubPort: 4100 }).problems).toEqual(["the backend's network log is missing"]);
    const file = log([{ purpose: "ai", url: "http://127.0.0.1:4100/v1/chat/completions", allowed: true }, { overflow: true }]);
    expect(netProblems({ log: file, blocked: [], stubPort: 4100 }).problems).toEqual(["the network log hit its bound: what came after it is unseen"]);
  });
});

describe("the network check on real models (plan 161)", () => {
  const aiHosts = ["api.anthropic.com", "api.openai.com", "api.typesafe.ai"];

  it("AI requests to the providers in use, over https, pass and are named; a refused icon is no request", () => {
    const file = log([
      { purpose: "ai", url: "https://api.anthropic.com/v1/messages", allowed: true },
      { purpose: "ai", url: "https://api.openai.com/v1/chat/completions", allowed: true },
      { purpose: "icons", url: "https://example.com/favicon.ico", allowed: false },
    ]);
    expect(netProblems({ log: file, blocked: [], aiHosts })).toEqual({ problems: [], decisions: 3, ai: 2, hosts: ["api.anthropic.com", "api.openai.com"] });
  });

  it("anything else fails: another AI host, plain http, a provider's host for something else, loopback AI, an update", () => {
    const file = log([
      { purpose: "ai", url: "https://api.groq.com/openai/v1/chat/completions", allowed: true },
      { purpose: "ai", url: "http://api.openai.com/v1/chat/completions", allowed: true },
      { purpose: "icons", url: "https://api.openai.com/favicon.ico", allowed: true },
      { purpose: "ai", url: "http://127.0.0.1:11434/api/tags", allowed: true },
      { purpose: "update", url: "https://updates.terno.app/feed", allowed: true },
    ]);
    expect(netProblems({ log: file, blocked: ["https://img.example/pixel.gif"], aiHosts }).problems).toEqual([
      "the window asked for https://img.example/pixel.gif",
      "an AI request went to api.groq.com, not a provider in use",
      "an AI request went to api.openai.com, not a provider in use",
      "the backend reached api.openai.com (icons)",
      "an AI request went to 127.0.0.1:11434, not a provider in use",
      "the backend reached updates.terno.app (update)",
    ]);
  });

  it("a host is allowed only with its key: without JEV's, JEV's host is refused", () => {
    const file = log([{ purpose: "ai", url: "https://api.typesafe.ai/v1/classify", allowed: true }]);
    expect(netProblems({ log: file, blocked: [], aiHosts: aiHosts.slice(0, 2) }).problems).toEqual(["an AI request went to api.typesafe.ai, not a provider in use"]);
  });

  it("`ai: true` is real models, the stub is asked for by name", () => {
    expect([aiMode(true), aiMode("real"), aiMode("stub"), aiMode(false), aiMode(undefined)]).toEqual(["real", "real", "stub", null, null]);
    expect(() => aiMode("ollama")).toThrow("ai takes");
  });
});

describe("the AI brief follows the round's models (plan 161, Codex review)", () => {
  const brief = readFileSync(new URL("./brief-ai.md", import.meta.url), "utf8");

  it("a real round's brief is brief-ai.md as written", () => {
    expect(briefFor(brief, "real")).toBe(brief);
    expect(brief).toContain("real AI models");
  });

  it("a stub round's brief speaks of the stand-in, and every launch in it asks for the stub, so a rater never spends", () => {
    const stub = briefFor(brief + "\nTry it, with `ai: true`, the summary.", "stub");
    expect(stub).toContain("local stand-in model that gives the same answers every time");
    expect(stub).not.toContain("real AI models");
    expect(stub).not.toContain("ai: true");
    expect(stub).toContain('ai: "stub"');
  });
});

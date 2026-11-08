import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { netProblems } from "./harness.mjs";

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
    expect(netProblems({ log: file, blocked: [], stubPort: 4100 })).toEqual({ problems: [], decisions: 3, ai: 2 });
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

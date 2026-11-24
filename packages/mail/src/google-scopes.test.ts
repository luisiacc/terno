import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectGmail } from "./gmail";
import { GMAIL_SCOPES } from "./gmail-api";

/**
 * Plan 258: Terno asks Google for exactly these, in every build. Google's verification rejected the contacts scopes,
 * so a new permission is a decision (and a new verification), never a side effect of a feature.
 */
const EXPECTED = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(path);
  }
  return out;
}

describe("the Google scopes Terno asks for (plan 258)", () => {
  it("are exactly openid, email, profile and gmail.modify", () => {
    expect(GMAIL_SCOPES).toEqual(EXPECTED);
  });

  it("are what the desktop consent asks for", async () => {
    let asked: string | null = null;
    const result = connectGmail({
      clientId: "synthetic-client",
      clientSecret: null,
      fetch: () => Promise.reject(new Error("no network in this test")),
      timeoutMs: 2000,
      openExternal: async (url) => {
        asked = new URL(url).searchParams.get("scope");
        throw new Error("stop at the consent screen");
      },
    });
    await expect(result).rejects.toThrow();
    expect(asked).toBe(EXPECTED.join(" "));
  });

  it("no shipped source names another Google API permission", () => {
    const found = new Map<string, string[]>();
    for (const top of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const src = join(ROOT, top, pkg, "src");
        if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const file of sources(src)) {
          for (const [scope] of readFileSync(file, "utf8").matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.-]+/g)) {
            found.set(scope, [...(found.get(scope) ?? []), relative(ROOT, file)]);
          }
        }
      }
    }
    // each other one, with the files naming it
    expect([...found].filter(([scope]) => scope !== EXPECTED[3])).toEqual([]);
    expect(found.has(EXPECTED[3]!)).toBe(true);
  });
});

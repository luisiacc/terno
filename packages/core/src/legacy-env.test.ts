import { describe, expect, it } from "vitest";
import { adoptLegacyEnv } from "./legacy-env";

describe("adoptLegacyEnv", () => {
  it("reads a UNICA_ variable as its TERNO_ successor, with a deprecation warning", () => {
    const env: Record<string, string | undefined> = { UNICA_USER_DATA: "/tmp/p", UNICA_SEED_ACCOUNTS: "3", HOME: "/h" };
    const warnings: string[] = [];
    expect(adoptLegacyEnv(env, (m) => warnings.push(m)).sort()).toEqual(["UNICA_SEED_ACCOUNTS", "UNICA_USER_DATA"]);
    expect(env).toEqual({ TERNO_USER_DATA: "/tmp/p", TERNO_SEED_ACCOUNTS: "3", HOME: "/h" });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/UNICA_USER_DATA is deprecated: use TERNO_USER_DATA/);
  });

  it("lets a TERNO_ variable win and says the legacy one is ignored", () => {
    const env: Record<string, string | undefined> = { UNICA_USER_DATA: "/old", TERNO_USER_DATA: "/new" };
    const warnings: string[] = [];
    expect(adoptLegacyEnv(env, (m) => warnings.push(m))).toEqual([]);
    expect(env).toEqual({ TERNO_USER_DATA: "/new" });
    expect(warnings).toEqual(["[terno] UNICA_USER_DATA is ignored: TERNO_USER_DATA is set."]);
  });

  it("is silent without legacy variables", () => {
    const warnings: string[] = [];
    expect(adoptLegacyEnv({ TERNO_DEMO: "1", PATH: "/bin" }, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

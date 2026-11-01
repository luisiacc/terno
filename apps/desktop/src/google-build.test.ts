import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { buildGoogleClients, withDotEnv } from "../../../scripts/release-env.mjs";

// Plan 99: what a desktop build bakes in (synthetic values only).
const both = { TERNO_GOOGLE_DESKTOP_ID: "prod-id", TERNO_GOOGLE_DESKTOP_SECRET: "prod-s", TERNO_GOOGLE_DESKTOP_DEV_ID: "dev-id", TERNO_GOOGLE_DESKTOP_DEV_SECRET: "dev-s" };

describe("plan 99: the build's Google clients", () => {
  it("bakes every client in, preferring prod in a release and dev otherwise", () => {
    expect(buildGoogleClients({ ...both, TERNO_RELEASE: "1" })).toEqual({ preferred: "prod-id", clients: [{ clientId: "prod-id", clientSecret: "prod-s" }, { clientId: "dev-id", clientSecret: "dev-s" }] });
    expect(buildGoogleClients(both).preferred).toBe("dev-id");
    expect(buildGoogleClients({ TERNO_GOOGLE_DESKTOP_ID: "prod-id", TERNO_GOOGLE_DESKTOP_SECRET: "prod-s" }).preferred).toBe("prod-id");
    expect(buildGoogleClients({})).toBeNull();
  });

  it("a release without its client fails, unless it says none on purpose", () => {
    expect(() => buildGoogleClients({ TERNO_RELEASE: "1", TERNO_GOOGLE_DESKTOP_DEV_ID: "dev-id" })).toThrow(/a release needs Terno's Google client/);
    expect(buildGoogleClients({ TERNO_RELEASE: "1", TERNO_GOOGLE_DESKTOP_ID: "" })).toBeNull();
  });

  it("reads .env under the environment (what is set wins)", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-dotenv-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "# comment\nTERNO_GOOGLE_DESKTOP_DEV_ID=from-file\nTERNO_GOOGLE_DESKTOP_DEV_SECRET=\"quoted\"\n");
      expect(withDotEnv({}, file)).toMatchObject({ TERNO_GOOGLE_DESKTOP_DEV_ID: "from-file", TERNO_GOOGLE_DESKTOP_DEV_SECRET: "quoted" });
      expect(withDotEnv({ TERNO_GOOGLE_DESKTOP_DEV_ID: "env" }, file).TERNO_GOOGLE_DESKTOP_DEV_ID).toBe("env");
      expect(withDotEnv({ A: "1" }, join(dir, "missing"))).toEqual({ A: "1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

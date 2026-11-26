import { describe, expect, it } from "vitest";
import { legacyNameAllowed } from "./keychain-helper";

describe("main: the legacy keychain helper (plan 283)", () => {
  it("opens Única's item, or a test's stand-in, but never Terno's own: the keychain trusts this binary, so that would read Terno's secrets without a prompt", () => {
    expect(legacyNameAllowed("Única", "Terno")).toBe(true);
    expect(legacyNameAllowed("TernoMigrationLegacy", "TernoMigrationNew")).toBe(true);
    expect(legacyNameAllowed("Terno", "Terno")).toBe(false);
    // a test name in the environment doesn't make Terno's item fair game
    expect(legacyNameAllowed("Terno", "TernoMigrationNew")).toBe(false);
    expect(legacyNameAllowed("TernoMigrationNew", "TernoMigrationNew")).toBe(false);
  });
});

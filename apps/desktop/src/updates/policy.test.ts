import { describe, expect, it } from "vitest";
import { applyTestBuild } from "../test-build";
import {
  bundleOf,
  Grants,
  installOutcome,
  mayCheck,
  mayDownload,
  parsePending,
  parsePrefs,
  resolveFeed,
  signedFromCodesign,
  unsupportedReason,
  updateRequestAllowed,
  type LocationProbe,
} from "./policy";

describe("updates: the network policy (local mode × setting × grants)", () => {
  it.each([
    // localMode, mode, trigger → check, download
    [false, "auto", "auto", true, true],
    [false, "manual", "auto", true, false],
    [true, "auto", "auto", false, false],
    [true, "manual", "auto", false, false],
    [false, "auto", "manual", true, true],
    [false, "manual", "manual", true, true],
    [true, "auto", "manual", true, true],
    [true, "manual", "manual", true, true],
  ] as const)("local mode %s, %s updates, %s trigger → check %s, download %s", (localMode, mode, trigger, check, download) => {
    expect(mayCheck({ localMode, trigger })).toBe(check);
    expect(mayDownload({ localMode, mode, trigger })).toBe(download);
  });

  it("grants: automatic ones are refused in local mode and revoked when it turns on; manual ones stay until released", () => {
    const g = new Grants();
    expect(g.grant("auto", { localMode: true })).toBeNull();
    expect(g.active).toBe(false);
    const auto = g.grant("auto", { localMode: false });
    const manual = g.grant("manual", { localMode: true });
    expect(auto).not.toBeNull();
    expect(g.revokeAutomatic()).toBe(true);
    expect(g.active).toBe(true);
    g.release(manual);
    expect(g.active).toBe(false);
    // releasing twice, or a revoked one, is harmless
    g.release(auto);
    g.release(manual);
    expect(g.active).toBe(false);
  });
});

describe("updates: where requests may go", () => {
  it.each([
    ["https://github.com/luisiacc/terno/releases.atom", true],
    ["https://github.com/luisiacc/terno/releases/download/v0.2.0/latest-mac.yml", true],
    ["https://objects.githubusercontent.com/github-production-release-asset/1/2?X-Amz=1", true],
    ["https://release-assets.githubusercontent.com/github-production-release-asset/1/2", true],
    ["https://api.github.com/repos/luisiacc/terno/releases", true],
    ["http://github.com/luisiacc/terno/releases.atom", false],
    ["https://github.com:8443/x", false],
    ["https://user:token@github.com/x", false],
    ["https://evil.example/latest-mac.yml", false],
    ["https://github.com.evil.example/x", false],
    ["https://raw.githubusercontent.com/x", false],
    ["http://127.0.0.1:8765/latest-mac.yml", false],
    ["not a url", false],
  ])("%s → %s", (url, allowed) => {
    expect(updateRequestAllowed(url, null)).toBe(allowed);
  });

  it("a test build reaches its own feed's origin, and only that", () => {
    const feed = "http://127.0.0.1:8765/feed/";
    expect(updateRequestAllowed("http://127.0.0.1:8765/feed/Terno-0.1.1-arm64-mac.zip", feed)).toBe(true);
    expect(updateRequestAllowed("http://127.0.0.1:8766/x", feed)).toBe(false);
    expect(updateRequestAllowed("http://localhost:8765/x", feed)).toBe(false);
  });
});

describe("updates: which copies can update themselves", () => {
  const ok: LocationProbe = { packaged: true, signed: true, translated: false, bundlePath: "/Applications/Terno.app", volumeReadOnly: false, parentWritable: true };
  it.each([
    ["a signed copy in Applications", ok, null],
    ["a dev build", { ...ok, packaged: false }, "dev"],
    ["an ad-hoc signed build", { ...ok, signed: false }, "unsigned"],
    ["App Translocation (opened from Downloads with the quarantine bit)", { ...ok, bundlePath: "/private/var/folders/ab/T/AppTranslocation/1234/d/Terno.app" }, "translocated"],
    ["the DMG", { ...ok, bundlePath: "/Volumes/Terno/Terno.app", volumeReadOnly: true }, "dmg"],
    ["another read-only volume", { ...ok, bundlePath: "/Users/me/ro/Terno.app", volumeReadOnly: true }, "read-only"],
    ["a folder it can't write", { ...ok, parentWritable: false }, "not-writable"],
    ["under Rosetta", { ...ok, translated: true }, "translated"],
    ["a writable external disk is fine", { ...ok, bundlePath: "/Volumes/Work/Apps/Terno.app" }, null],
    ["signature unknown (codesign failed) doesn't block", { ...ok, signed: null }, null],
  ] as const)("%s", (_name, probe, reason) => {
    expect(unsupportedReason(probe as LocationProbe)).toBe(reason);
  });

  it("finds the bundle from the executable, and reads codesign", () => {
    expect(bundleOf("/Applications/Terno.app/Contents/MacOS/Terno")).toBe("/Applications/Terno.app");
    expect(bundleOf("/usr/local/bin/electron")).toBeNull();
    expect(signedFromCodesign("Executable=/A/Terno.app/Contents/MacOS/Terno\nSignature=adhoc\nTeamIdentifier=not set")).toBe(false);
    expect(signedFromCodesign("Authority=Apple Development: x (DA229N496G)\nTeamIdentifier=75G23QY623")).toBe(true);
    expect(signedFromCodesign("code object is not signed at all")).toBeNull();
  });
});

describe("updates: the feed, prefs and the install record", () => {
  it("a release (no baked test config) ignores the environment: GitHub's feed, the user's own profile", async () => {
    const before = { ...process.env };
    process.env.TERNO_TEST = "1";
    process.env.TERNO_UPDATE_FEED = "http://127.0.0.1:1/evil/";
    try {
      const { TEST_BUILD, applyTestBuild } = await import("../test-build");
      expect(TEST_BUILD).toBeUndefined();
      expect(resolveFeed(TEST_BUILD)).toEqual({ provider: "github", owner: "luisiacc", repo: "terno" });
      const env: NodeJS.ProcessEnv = { TERNO_USER_DATA: "/tmp/mine" };
      applyTestBuild(env);
      expect(env).toEqual({ TERNO_USER_DATA: "/tmp/mine" });
    } finally {
      process.env = before;
    }
  });

  it("a test build's baked feed and profile win over whatever the environment says", () => {
    const baked = { feed: "http://127.0.0.1:8765/", userData: "/tmp/t/profile", appData: "/tmp/t/appdata", appName: "TernoUpdateTest" };
    expect(resolveFeed(baked)).toEqual({ provider: "generic", url: "http://127.0.0.1:8765/" });
    const env: NodeJS.ProcessEnv = { TERNO_USER_DATA: "/tmp/mine" };
    applyTestBuild(env, baked);
    expect(env).toEqual({ TERNO_USER_DATA: "/tmp/t/profile", TERNO_TEST_APP_DATA: "/tmp/t/appdata", TERNO_TEST_APP_NAME: "TernoUpdateTest" });
  });

  it("prefs default to automatic and stable, and anything malformed falls back", () => {
    expect(parsePrefs(undefined)).toEqual({ mode: "auto", channel: "stable", checkedAt: null });
    expect(parsePrefs({ mode: "manual", channel: "nightly", checkedAt: 5 })).toEqual({ mode: "manual", channel: "nightly", checkedAt: 5 });
    expect(parsePrefs({ mode: "x", channel: 1, checkedAt: "now" })).toEqual({ mode: "auto", channel: "stable", checkedAt: null });
  });

  it("the install record: applied when the target runs, not applied when the old one still does, silent otherwise", () => {
    const p = parsePending({ from: "0.1.0", to: "0.2.0", txId: "abc", at: 1 })!;
    expect(installOutcome(p, "0.2.0")).toBe("applied");
    expect(installOutcome(p, "0.1.0")).toBe("not-applied");
    expect(installOutcome(p, "0.3.0")).toBeNull();
    expect(parsePending({ from: "0.1.0", to: "../../etc", txId: "a", at: 1 })).toBeNull();
    expect(parsePending("junk")).toBeNull();
  });
});

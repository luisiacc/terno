import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { dispatch, dispatchArgs, isMainTip, preflight, REQUIRED_SECRETS, tagExists } from "../scripts/release-ci.mjs";
// @ts-expect-error a build script (plain JS)
import { builderIdentity } from "../scripts/sign-identity.mjs";

// Plan 126: releases build on GitHub. Synthetic values only.
const sha = "0123456789abcdef0123456789abcdef01234567";
const full = Object.fromEntries((REQUIRED_SECRETS as string[]).map((name) => [name, "x"]));
const workflow = readFileSync(join(__dirname, "../../../.github/workflows/release-mac.yml"), "utf8");
/** One step's text, from its `- name:` to the next step. */
const step = (name: string) => {
  const start = workflow.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`no step "${name}"`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
};

describe("plan 126: the release preflight", () => {
  it("passes a full set of secrets with a SHA, and a nightly version", () => {
    expect(preflight({ ...full, RELEASE_SHA: sha })).toEqual([]);
    expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4.0-nightly.3" })).toEqual([]);
  });

  it("names every missing or empty secret, never its value, so a release can't ship without Google sign-in", () => {
    // GitHub passes an unset secret as "", which buildGoogleClients would read as "a fork, no client"
    const problems = preflight({ ...full, TERNO_GOOGLE_DESKTOP_ID: "", MAC_CERT_P12: "  ", APPLE_API_ISSUER: undefined, RELEASE_SHA: sha });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/TERNO_GOOGLE_DESKTOP_ID[\s\S]*MAC_CERT_P12[\s\S]*APPLE_API_ISSUER/);
    expect(preflight({ RELEASE_SHA: sha })).toHaveLength(REQUIRED_SECRETS.length);
    expect(preflight({ ...full, MAC_CERT_PASSWORD: "hunter2-but-empty-cert", MAC_CERT_P12: "", RELEASE_SHA: sha }).join("")).not.toContain("hunter2");
  });

  it("rejects a short or odd SHA and a version release.mjs wouldn't release", () => {
    expect(preflight({ ...full, RELEASE_SHA: "abc123" })).toEqual([expect.stringMatching(/40-character SHA/)]);
    expect(preflight({ ...full })).toEqual([expect.stringMatching(/40-character SHA/)]);
    expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4.0-beta.1" })).toEqual([expect.stringMatching(/isn't x\.y\.z/)]);
    expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4; rm -rf /" })).toHaveLength(1);
  });
});

describe("plan 126: starting a release from this Mac", () => {
  it("dispatches the workflow on main for the commit, with a version only when given", () => {
    expect(dispatchArgs({ sha })).toEqual(["workflow", "run", "release-mac.yml", "--repo", "luisiacc/terno", "--ref", "main", "-f", `sha=${sha}`]);
    expect(dispatchArgs({ sha, version: "1.4.0-nightly.3" }).slice(-2)).toEqual(["-f", "version=1.4.0-nightly.3"]);
  });

  it("releases only main's tip: an older commit would bring older release scripts", () => {
    const answer = (status: number, stdout: string) => () => ({ status, stdout });
    expect(isMainTip(sha, answer(0, `${sha}\n`))).toBe(true);
    expect(isMainTip(sha, answer(0, "fedcba9876543210fedcba9876543210fedcba98\n"))).toBe(false); // not pushed, or main moved on
    expect(isMainTip(sha, answer(1, ""))).toBe(false);
  });

  it("a tag left without a release stops it: gh would reuse the tag wherever it points", () => {
    const asked: string[][] = [];
    expect(tagExists("1.4.0", (args: string[]) => (asked.push(args), { status: 0 }))).toBe(true);
    expect(asked[0]).toContain("repos/luisiacc/terno/git/ref/tags/v1.4.0");
    expect(tagExists("1.4.0", () => ({ status: 1 }))).toBe(false);
  });

  it("returns the run created after the dispatch, ignoring older runs", () => {
    const calls: string[][] = [];
    const old = { url: "https://github.com/luisiacc/terno/actions/runs/1", createdAt: "2020-01-01T00:00:00Z" };
    const fresh = { url: "https://github.com/luisiacc/terno/actions/runs/2", createdAt: new Date(Date.now() + 1_000).toISOString() };
    let lists = 0;
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "workflow") return { status: 0, stdout: "", stderr: "" };
      lists++;
      return { status: 0, stdout: JSON.stringify(lists === 1 ? [old] : [fresh, old]), stderr: "" };
    };
    expect(dispatch({ sha }, run, () => {})).toBe(fresh.url);
    expect(calls[0]).toEqual(dispatchArgs({ sha }));
    expect(lists).toBe(2);
  });

  it("a failed dispatch says why, and an unlisted run gives up quietly", () => {
    expect(() => dispatch({ sha }, () => ({ status: 1, stdout: "", stderr: "HTTP 404: workflow not found" }), () => {})).toThrow(/workflow not found/);
    const never = (args: string[]) => ({ status: 0, stdout: args[0] === "run" ? "[]" : "", stderr: "" });
    expect(dispatch({ sha }, never, () => {})).toBeNull();
  });
});

describe("plan 126 review: the identity electron-builder gets", () => {
  it("drops the Developer ID prefix electron-builder refuses, and leaves others alone", () => {
    const req = createRequire(createRequire(join(__dirname, "../package.json")).resolve("electron-builder"));
    const { appleCertificatePrefixes } = req("app-builder-lib/out/codeSign/macCodeSign.js") as { appleCertificatePrefixes: string[] };
    const name = builderIdentity("Developer ID Application: Luisiacc LLC (ABCDE12345)");
    expect(name).toBe("Luisiacc LLC (ABCDE12345)");
    for (const prefix of appleCertificatePrefixes) expect(name.startsWith(prefix)).toBe(false);
    expect(builderIdentity("Apple Development: Luis (XYZ)")).toBe("Apple Development: Luis (XYZ)");
    expect(builderIdentity("-")).toBe("-");
  });
});

describe("plan 126: the release workflow", () => {
  it("only a person with write access starts it: no push, pull request or other trigger", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).toContain("workflow_dispatch:");
    expect(on).not.toMatch(/pull_request|push:|workflow_run|schedule|issue|release:/);
  });

  it("runs in the release environment, whose secrets deploy from main only, and builds main's tip", () => {
    expect(workflow).toMatch(/\n {4}environment: release\n/);
    expect(step("The commit is main's tip")).toContain('[ "$GITHUB_SHA" = "$RELEASE_SHA" ]');
    expect(workflow).not.toMatch(/ref: \$\{\{ inputs/); // never checks out a commit the caller names
  });

  it("pins every action to a commit and keeps the checkout's token off the disk (the job holds the signing key)", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("persist-credentials: false");
  });

  it("installs third-party code before the keys exist on the runner", () => {
    const at = (text: string) => workflow.indexOf(text);
    for (const before of ["pnpm install", "- name: Sign in to Sentry"]) {
      expect(at(before)).toBeGreaterThan(0);
      expect(at(before)).toBeLessThan(at("- name: Import the Developer ID certificate"));
      expect(at(before)).toBeLessThan(at("- name: Write the notarization key"));
    }
    expect(step("Import the Developer ID certificate")).toContain('codesign --force --sign "$IDENTITY"');
  });

  it("no shell line expands an input or a secret (they reach scripts through env only)", () => {
    const lines = workflow.split("\n");
    const shell: string[] = [];
    lines.forEach((line, i) => {
      const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
      if (!m) return;
      const [, indent = "", body = ""] = m;
      shell.push(body);
      if (body !== "|") return;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() !== "" && next.search(/\S/) <= indent.length) break;
        shell.push(next);
      }
    });
    expect(shell.length).toBeGreaterThan(10);
    expect(shell.filter((l) => l.includes("${{"))).toEqual([]);
  });

  it("checks every required secret before the build, and the build gets the Google clients", () => {
    for (const name of REQUIRED_SECRETS as string[]) expect(step("Check the secrets")).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(step("Check the secrets")).toContain("release-ci.mjs check");
    const build = step("Build, sign, notarize and draft the release");
    for (const name of ["TERNO_GOOGLE_DESKTOP_ID", "TERNO_GOOGLE_DESKTOP_SECRET", "TERNO_GOOGLE_WEB_ID", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) expect(build).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(build).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow.indexOf("- name: Check the secrets")).toBeLessThan(workflow.indexOf("pnpm install"));
  });

  it("removes the keychain and the notarization key whatever happened", () => {
    const cleanup = step("Remove the keychain and the key");
    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain("security delete-keychain");
    expect(cleanup).toContain('rm -rf "$RUNNER_TEMP/notary"');
  });
});

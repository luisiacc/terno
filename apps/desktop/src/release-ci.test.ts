import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { deleteFailedDraft, dispatch, dispatchArgs, isMainTip, PHASE_SECRETS, preflight, REQUIRED_SECRETS, tagExists } from "../scripts/release-ci.mjs";
// @ts-expect-error a build script (plain JS)
import { channelOf, LINUX_ARCHES, linuxPackages, packageVersion, releaseAssets } from "../scripts/release-assets.mjs";
// @ts-expect-error a build script (plain JS)
import { builderIdentity } from "../scripts/sign-identity.mjs";

// Plans 126 and 189: releases build on GitHub. Synthetic values only.
const sha = "0123456789abcdef0123456789abcdef01234567";
const full = Object.fromEntries((REQUIRED_SECRETS as string[]).map((name) => [name, "x"]));
const workflow = readFileSync(join(__dirname, "../../../.github/workflows/release.yml"), "utf8");
const JOBS = ["linux", "mac", "draft"] as const;
/** One job's text, from its `  <name>:` line under `jobs:` to the next job. */
const job = (name: (typeof JOBS)[number]) => {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const start = jobs.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job "${name}"`);
  const next = jobs.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return jobs.slice(start, next < 0 ? undefined : start + 1 + next);
};
/** One step's text in a job, from its `- name:` to the next step. */
const step = (name: string, inJob: (typeof JOBS)[number] = "mac") => {
  const text = job(inJob);
  const start = text.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`no step "${name}" in ${inJob}`);
  const next = text.indexOf("\n      - ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
};

describe("plan 126: the release preflight", () => {
  it("passes a full set of secrets with a SHA, and a nightly version, in every phase", () => {
    for (const phase of ["build-mac", "build-linux", "draft"]) {
      expect(preflight({ ...full, RELEASE_SHA: sha }, phase)).toEqual([]);
      expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4.0-nightly.3" }, phase)).toEqual([]);
    }
  });

  it("names every missing or empty secret, never its value, so a release can't ship without Google sign-in", () => {
    // GitHub passes an unset secret as "", which buildGoogleClients would read as "a fork, no client"
    const problems = preflight({ ...full, TERNO_GOOGLE_DESKTOP_ID: "", MAC_CERT_P12: "  ", APPLE_API_ISSUER: undefined, RELEASE_SHA: sha }, "build-mac");
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/TERNO_GOOGLE_DESKTOP_ID[\s\S]*MAC_CERT_P12[\s\S]*APPLE_API_ISSUER/);
    expect(preflight({ RELEASE_SHA: sha }, "build-mac")).toHaveLength(REQUIRED_SECRETS.length);
    expect(preflight({ ...full, MAC_CERT_PASSWORD: "hunter2-but-empty-cert", MAC_CERT_P12: "", RELEASE_SHA: sha }, "build-mac").join("")).not.toContain("hunter2");
  });

  it("plan 189: each phase checks only its own secrets: Linux the Google clients, the draft none", () => {
    expect(preflight({ RELEASE_SHA: sha }, "build-linux")).toEqual(["TERNO_GOOGLE_DESKTOP_ID", "TERNO_GOOGLE_DESKTOP_SECRET", "TERNO_GOOGLE_WEB_ID"].map((n) => expect.stringContaining(n)));
    expect(preflight({ RELEASE_SHA: sha }, "draft")).toEqual([]);
    expect(PHASE_SECRETS["build-linux"]).not.toContain("MAC_CERT_P12");
    expect(preflight({ ...full, RELEASE_SHA: sha }, "publish")).toEqual([expect.stringMatching(/unknown phase/)]);
    expect(preflight({ ...full, RELEASE_SHA: sha }, undefined)).toHaveLength(1);
  });

  it("rejects a short or odd SHA and a version release.mjs wouldn't release", () => {
    expect(preflight({ ...full, RELEASE_SHA: "abc123" }, "build-mac")).toEqual([expect.stringMatching(/40-character SHA/)]);
    expect(preflight({ ...full }, "draft")).toEqual([expect.stringMatching(/40-character SHA/)]);
    expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4.0-beta.1" }, "build-linux")).toEqual([expect.stringMatching(/isn't x\.y\.z/)]);
    expect(preflight({ ...full, RELEASE_SHA: sha, TERNO_VERSION: "1.4; rm -rf /" }, "build-mac")).toHaveLength(1);
  });
});

describe("plan 189: what a release carries", () => {
  it("macOS: the zip, its blockmap, the channel file and the DMG; Linux: a deb and an rpm per architecture", () => {
    expect(releaseAssets("1.4.0", ["mac"])).toEqual(["Terno-1.4.0-arm64-mac.zip", "Terno-1.4.0-arm64-mac.zip.blockmap", "latest-mac.yml", "Terno-1.4.0-arm64.dmg"]);
    // each format's own architecture name, as electron-builder writes it and as users look for it
    expect(releaseAssets("1.4.0", ["linux"])).toEqual(["Terno-1.4.0-linux-amd64.deb", "Terno-1.4.0-linux-x86_64.rpm", "Terno-1.4.0-linux-arm64.deb", "Terno-1.4.0-linux-aarch64.rpm"]);
    // GitHub's draft has both; --local only macOS
    expect(releaseAssets("1.4.0", ["mac", "linux"])).toHaveLength(8);
    expect(() => releaseAssets("1.4.0", ["windows"])).toThrow(/unknown platform/);
  });

  it("a nightly: its own channel file, and the packages record a version that sorts before the release (~)", () => {
    expect(releaseAssets("1.4.0-nightly.3", ["mac"])).toContain("nightly-mac.yml");
    expect(channelOf("1.4.0")).toBe("latest");
    expect(linuxPackages("1.4.0-nightly.3", "arm64")).toEqual(["Terno-1.4.0-nightly.3-linux-arm64.deb", "Terno-1.4.0-nightly.3-linux-aarch64.rpm"]);
    expect(() => linuxPackages("1.4.0", "ia32")).toThrow(/unknown architecture/);
    expect(packageVersion("1.4.0-nightly.3")).toBe("1.4.0~nightly.3");
    expect(packageVersion("1.4.0")).toBe("1.4.0");
  });

  it("names each architecture as deb, rpm and `file` do", () => {
    expect(LINUX_ARCHES.map((a: { arch: string; deb: string; rpm: string }) => [a.arch, a.deb, a.rpm])).toEqual([["x64", "amd64", "x86_64"], ["arm64", "arm64", "aarch64"]]);
  });
});

describe("plan 126: starting a release from this Mac", () => {
  it("dispatches the workflow on main for the commit, with a version only when given", () => {
    expect(dispatchArgs({ sha })).toEqual(["workflow", "run", "release.yml", "--repo", "luisiacc/terno", "--ref", "main", "-f", `sha=${sha}`]);
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

  it("returns the URL gh prints for the new run", () => {
    const run = (args: string[]) => (args[0] === "workflow" ? { status: 0, stdout: "https://github.com/luisiacc/terno/actions/runs/42\n", stderr: "" } : { status: 0, stdout: "[]", stderr: "" });
    expect(dispatch({ sha }, run, () => {})).toBe("https://github.com/luisiacc/terno/actions/runs/42");
  });

  it("without a printed URL, returns the first run that wasn't there before, never an earlier one (review)", () => {
    const calls: string[][] = [];
    // the earlier run is seconds old: a timestamp window would have taken it
    const earlier = { databaseId: 1, url: "https://github.com/luisiacc/terno/actions/runs/1" };
    const fresh = { databaseId: 2, url: "https://github.com/luisiacc/terno/actions/runs/2" };
    let lists = 0;
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "workflow") return { status: 0, stdout: "", stderr: "" };
      lists++;
      return { status: 0, stdout: JSON.stringify(lists <= 2 ? [earlier] : [fresh, earlier]), stderr: "" };
    };
    expect(dispatch({ sha }, run, () => {})).toBe(fresh.url);
    expect(calls[1]).toEqual(dispatchArgs({ sha })); // listed once before dispatching
    expect(lists).toBe(3);
  });

  it("a failed dispatch says why, and an unlisted run gives up quietly", () => {
    expect(() => dispatch({ sha }, (args: string[]) => (args[0] === "workflow" ? { status: 1, stdout: "", stderr: "HTTP 404: workflow not found" } : { status: 0, stdout: "[]", stderr: "" }), () => {})).toThrow(/workflow not found/);
    const never = (args: string[]) => ({ status: 0, stdout: args[0] === "run" ? "[]" : "", stderr: "" });
    expect(dispatch({ sha }, never, () => {})).toBeNull();
  });
});

describe("plan 126 review: a failed upload doesn't block the retry", () => {
  const gh = (isDraft: string | null) => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return isDraft === null ? { status: 1, stdout: "" } : { status: 0, stdout: `${isDraft}\n` };
      return { status: 0, stdout: "" };
    };
    return { run, deleted: () => calls.some((a) => a[1] === "delete") };
  };

  it("deletes the draft gh left behind", () => {
    const g = gh("true");
    expect(deleteFailedDraft("1.4.0", g.run)).toBe(true);
    expect(g.deleted()).toBe(true);
  });

  it("never deletes a published release, nor anything when there is none", () => {
    for (const state of ["false", null]) {
      const g = gh(state);
      expect(deleteFailedDraft("1.4.0", g.run)).toBe(false);
      expect(g.deleted()).toBe(false);
    }
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

  it("builds in the release environment, whose secrets deploy from main only, and every job builds main's tip", () => {
    for (const j of ["linux", "mac"] as const) expect(job(j)).toMatch(/\n {4}environment: release\n/);
    for (const j of JOBS) expect(step("The commit is main's tip", j)).toContain('[ "$GITHUB_SHA" = "$RELEASE_SHA" ]');
    expect(workflow).not.toMatch(/ref: \$\{\{ inputs/); // never checks out a commit the caller names
  });

  it("plan 189: only the draft can write, it holds no secret, and it waits for both builds", () => {
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
    expect(job("linux")).toMatch(/permissions:\n {6}contents: read\n/);
    expect(job("mac")).toMatch(/permissions:\n {6}contents: read\n/);
    expect(job("draft")).toMatch(/permissions:\n {6}contents: write/);
    expect(job("draft")).toContain("needs: [linux, mac]");
    expect(job("draft")).not.toContain("secrets.");
    expect(job("draft")).not.toContain("environment:");
    expect(job("draft")).not.toContain("pnpm install");
    expect(step("Draft the release", "draft")).toContain('release.mjs draft "$RUNNER_TEMP/release-mac" "$RUNNER_TEMP/release-linux"');
    // the build jobs never hold a token that can write, nor call gh
    for (const j of ["linux", "mac"] as const) expect(job(j)).not.toContain("GH_TOKEN");
  });

  it("plan 189: Linux builds both architectures, installs the x64 deb, smoke-tests it sandboxed, and only then keeps the packages", () => {
    const linux = job("linux");
    const at = (text: string) => linux.indexOf(text);
    expect(step("Install the packaging and test tools", "linux")).toMatch(/\brpm\b[\s\S]*xvfb[\s\S]*gnome-keyring/);
    expect(step("Build and package for Linux", "linux")).toContain("release.mjs build-linux");
    const install = step("Install the x64 package", "linux");
    expect(install).toContain("kernel.apparmor_restrict_unprivileged_userns=1");
    expect(install).toContain("apt-get install -y ./apps/desktop/release/Terno-*-linux-amd64.deb");
    expect(step("Smoke-test the installed app", "linux")).toContain("test:smoke:linux");
    expect(at("- name: Build and package for Linux")).toBeLessThan(at("- name: Install the x64 package"));
    expect(at("- name: Install the x64 package")).toBeLessThan(at("- name: Smoke-test the installed app"));
    expect(at("- name: Smoke-test the installed app")).toBeLessThan(at("- name: Keep the packages for the draft"));
    expect(linux).not.toMatch(/MAC_CERT|APPLE_API/);
  });

  it("plan 189: each platform's artifacts have their own names, and the draft downloads only the packages", () => {
    const names = [...workflow.matchAll(/\n\s+name: (release-\S+|source-maps-\S+)/g)].map((m) => m[1]);
    expect(names).toEqual(["release-linux", "source-maps-linux-${{", "release-mac", "source-maps-mac-${{", "release-mac", "release-linux"]);
    expect(new Set(names.slice(0, 4)).size).toBe(4);
  });

  it("pins every action to a commit and keeps the checkout's token off the disk (the job holds the signing key)", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThanOrEqual(12);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("persist-credentials: false");
  });

  it("installs third-party code before the keys exist on the runner", () => {
    const mac = job("mac");
    const at = (text: string) => mac.indexOf(text);
    for (const before of ["pnpm install", "- name: Sign in to Sentry"]) {
      expect(at(before)).toBeGreaterThan(0);
      expect(at(before)).toBeLessThan(at("- name: Import the Developer ID certificate"));
      expect(at(before)).toBeLessThan(at("- name: Write the notarization key"));
    }
    expect(step("Import the Developer ID certificate")).toContain('codesign --force --sign "$IDENTITY"');
  });

  it("the import step fails when codesign can't use the key, before the build (review)", () => {
    const text = step("Import the Developer ID certificate");
    const script = text.slice(text.indexOf("run: |") + 7).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
    const dir = mkdtempSync(join(tmpdir(), "terno-release-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      stub("curl", 'while [ $# -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done');
      stub("openssl", "echo pw");
      stub("security", 'if [ "$1" = find-identity ]; then echo \'  1) ABC "Developer ID Application: Synthetic (TEAM)"\'; fi; exit 0');
      const runStep = (codesign: number) => {
        stub("codesign", `exit ${codesign}`);
        return spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, MAC_CERT_P12: Buffer.from("p12").toString("base64"), MAC_CERT_PASSWORD: "x" } });
      };
      expect(runStep(0).status).toBe(0);
      const failed = runStep(1);
      expect(failed.status).not.toBe(0);
      expect(failed.stdout).not.toContain("✓ signing as");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("each build checks its phase's secrets before installing anything, and its build gets the Google clients", () => {
    for (const [j, phase] of [["mac", "build-mac"], ["linux", "build-linux"]] as const) {
      for (const name of PHASE_SECRETS[phase] as string[]) expect(step("Check the secrets", j)).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(step("Check the secrets", j)).toContain(`release-ci.mjs check ${phase}`);
      expect(job(j).indexOf("- name: Check the secrets")).toBeLessThan(job(j).indexOf("pnpm install"));
    }
    expect(step("Check the version", "draft")).toContain("release-ci.mjs check draft");
    const mac = step("Build, sign and notarize");
    for (const name of ["TERNO_GOOGLE_DESKTOP_ID", "TERNO_GOOGLE_DESKTOP_SECRET", "TERNO_GOOGLE_WEB_ID", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) expect(mac).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(mac).toContain("release.mjs build-mac");
    const linux = step("Build and package for Linux", "linux");
    for (const name of ["TERNO_GOOGLE_DESKTOP_ID", "TERNO_GOOGLE_DESKTOP_SECRET", "TERNO_GOOGLE_WEB_ID"]) expect(linux).toContain(`${name}: \${{ secrets.${name} }}`);
    expect(step("Draft the release", "draft")).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("removes the keychain and the notarization key whatever happened", () => {
    const cleanup = step("Remove the keychain and the key");
    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain("security delete-keychain");
    expect(cleanup).toContain('rm -rf "$RUNNER_TEMP/notary"');
  });
});

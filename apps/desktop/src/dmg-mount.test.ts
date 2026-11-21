import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dmgProblems, hasCustomIconFlag, withMounted, withRetries, type Run, type VolumeView } from "./dmg-mount";

/** a pretend hdiutil: attach mounts `volumes` directories under -mountrandom's parent (then maybe fails), detach unmounts */
function fakeHdiutil({ volumes = 1, attachFails = false, detachFails = false } = {}) {
  const calls: string[][] = [];
  const mounted: string[] = [];
  const run: Run = (_cmd, args) => {
    calls.push(args);
    if (args[0] === "attach") {
      const parent = args[args.indexOf("-mountrandom") + 1]!;
      for (let i = 0; i < volumes; i++) {
        const v = join(parent, `dmg.${i}`);
        mkdirSync(v);
        writeFileSync(join(v, "Terno.app"), "app");
        mounted.push(v);
      }
      if (attachFails) throw new Error("attach failed half-way");
    }
    if (args[0] === "detach") {
      if (detachFails) throw new Error("busy");
      rmSync(args[1]!, { recursive: true, force: true });
    }
  };
  return { run, calls, mounted };
}

describe("withMounted (plan 19, the DMG volume icon)", () => {
  it("runs on the volume and detaches it", () => {
    const h = fakeHdiutil();
    let seen = "";
    withMounted("/x.dmg", true, (v) => (seen = v), h.run);
    expect(seen).toBe(h.mounted[0]);
    expect(h.calls[0]).toEqual(expect.arrayContaining(["attach", "/x.dmg", "-nobrowse", "-readonly", "-mountrandom"]));
    expect(h.calls.filter((c) => c[0] === "detach").map((c) => c[1])).toEqual(h.mounted);
    expect(existsSync(join(h.mounted[0]!, ".."))).toBe(false);
  });

  it("detaches when what runs on the volume throws", () => {
    const h = fakeHdiutil();
    expect(() => withMounted("/x.dmg", false, () => { throw new Error("SetFile failed"); }, h.run)).toThrow("SetFile failed");
    expect(h.calls.at(-1)).toEqual(["detach", h.mounted[0], "-force"]);
  });

  it("detaches what got mounted even when attaching fails half-way, or mounts more than expected", () => {
    const half = fakeHdiutil({ attachFails: true });
    expect(() => withMounted("/x.dmg", true, () => {}, half.run)).toThrow("half-way");
    expect(half.calls.filter((c) => c[0] === "detach").map((c) => c[1])).toEqual(half.mounted);
    const two = fakeHdiutil({ volumes: 2 });
    expect(() => withMounted("/x.dmg", true, () => {}, two.run)).toThrow(/one mounted volume, found 2/);
    expect(two.calls.filter((c) => c[0] === "detach").map((c) => c[1])).toEqual(two.mounted);
  });

  it("never deletes into a volume it couldn't detach", () => {
    const h = fakeHdiutil({ detachFails: true });
    withMounted("/x.dmg", true, () => {}, h.run);
    expect(existsSync(join(h.mounted[0]!, "Terno.app"))).toBe(true);
    rmSync(join(h.mounted[0]!, ".."), { recursive: true, force: true });
  });

  it("loads in plain Node (package.mjs imports it with type stripping only)", () => {
    const file = join(import.meta.dirname, "dmg-mount.ts");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(file)}); console.log(typeof m.withMounted)`], { encoding: "utf8" });
    expect(out.trim()).toBe("function");
  });
});

describe("the drag-to-install DMG (plan 226)", () => {
  const good: Record<string, { dir?: boolean; link?: string }> = {
    "/v/Terno.app": { dir: true },
    "/v/Applications": { link: "/Applications" },
    "/v/.VolumeIcon.icns": {},
    "/v/.background.tiff": {},
    "/v/.DS_Store": {},
  };
  const view = (files: Record<string, { dir?: boolean; link?: string }>, customIcon = true): VolumeView => ({
    isDir: (p) => files[p]?.dir === true,
    link: (p) => files[p]?.link ?? null,
    exists: (p) => p in files,
    list: (p) => Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    customIcon: () => customIcon,
  });
  const without = (name: string) => Object.fromEntries(Object.entries(good).filter(([k]) => k !== name));

  it("passes a volume with the app, the Applications link, the icon, the background and the layout", () => {
    expect(dmgProblems("/v", "Terno", view(good))).toEqual([]);
  });

  it("names each missing piece", () => {
    expect(dmgProblems("/v", "Terno", view(without("/v/Terno.app")))).toEqual(["no Terno.app at its root"]);
    expect(dmgProblems("/v", "Terno", view(without("/v/Applications")))).toEqual(["no Applications link to /Applications"]);
    expect(dmgProblems("/v", "Terno", view({ ...good, "/v/Applications": { dir: true } }))).toEqual(["no Applications link to /Applications"]);
    expect(dmgProblems("/v", "Terno", view({ ...good, "/v/Applications": { link: "/Users/x/Applications" } }))).toEqual(["no Applications link to /Applications"]);
    expect(dmgProblems("/v", "Terno", view(good, false))).toEqual(["the volume has no icon"]);
    expect(dmgProblems("/v", "Terno", view(without("/v/.VolumeIcon.icns")))).toEqual(["the volume has no icon"]);
    expect(dmgProblems("/v", "Terno", view(without("/v/.background.tiff")))).toEqual(["no background image"]);
    expect(dmgProblems("/v", "Terno", view(without("/v/.DS_Store")))).toEqual(["no window layout (.DS_Store)"]);
  });

  it("reads the custom-icon flag from com.apple.FinderInfo", () => {
    expect(hasCustomIconFlag("00 00 00 00 00 00 00 00 04 00 00 00 00 00 00 00\n00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00")).toBe(true);
    expect(hasCustomIconFlag("00000000000000000000000000000000")).toBe(false);
    expect(hasCustomIconFlag("")).toBe(false);
  });

  it("retries a step that fails, cleaning up between tries, and gives up after the last", async () => {
    let calls = 0;
    const cleaned: number[] = [];
    const slept: number[] = [];
    const result = await withRetries(async () => {
      if (++calls < 3) throw new Error("hdiutil: Resource busy");
      return "made";
    }, { tries: 3, waitMs: 5000, label: "the DMG", cleanup: () => cleaned.push(calls), sleep: async (ms) => void slept.push(ms), warn: () => {} });
    expect(result).toBe("made");
    expect(cleaned).toEqual([1, 2]);
    expect(slept).toEqual([5000, 5000]);
    await expect(withRetries(async () => { throw new Error("still busy"); }, { tries: 3, waitMs: 1, label: "x", sleep: async () => {}, warn: () => {} })).rejects.toThrow("still busy");
  });
});

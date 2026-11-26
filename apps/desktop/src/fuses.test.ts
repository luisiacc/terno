import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a build script (plain JS)
import { fuseFile, fuseProblems, fuseTable, makeInspectable, readWire } from "../scripts/fuses.mjs";
// @ts-expect-error a build script (plain JS)
import { commonConfig, electronDist } from "../scripts/package-stage.mjs";
// @ts-expect-error a build script (plain JS)
import { STEP_ENV } from "../scripts/release-ci.mjs";

// Plan 283 (CASA 6.2.1): the fuses every package carries. Only Node's inspector differs between a shipped build and an
// inspectable one (the smoke suite's), and only a release ships.
const ON = 49;
const OFF = 48;
const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
/** Electron 45's defaults, as the wire holds them: RunAsNode, cookie encryption, NODE_OPTIONS, inspect, asar integrity, asar only, V8 snapshot, file:// privileges, Wasm trap handlers */
const DEFAULTS = [ON, OFF, ON, ON, OFF, OFF, OFF, ON, ON];
/** a binary with one wire (or two, as a universal Mach-O has) */
const binary = (states: number[], copies = 1) => Buffer.concat(Array.from({ length: copies }, () => Buffer.concat([Buffer.from("padding"), Buffer.from(SENTINEL), Buffer.from([1, states.length, ...states]), Buffer.from("more")])));
const set = (states: number[], at: Record<number, number>) => states.map((s, i) => at[i] ?? s);
const shippedMac = set(DEFAULTS, { 2: OFF, 3: OFF, 4: ON, 5: ON });

describe("release: Electron's fuses (plan 283)", () => {
  it("pins the table: NODE_OPTIONS off, the asar only and integrity-checked (macOS), the inspector off when shipped; RunAsNode on for the agents' connector", () => {
    expect(fuseTable({ platform: "darwin", shipped: true })).toEqual({
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    expect(fuseTable({ platform: "darwin", shipped: false })).toEqual({ ...fuseTable({ platform: "darwin", shipped: true }), enableNodeCliInspectArguments: true });
    // Electron checks an embedded asar hash on macOS and Windows only
    expect(fuseTable({ platform: "linux", shipped: true })).toEqual({ runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true });
  });

  it("reads a wire back: a shipped build's passes, Electron's defaults fail by name, an inspectable build isn't shipped", () => {
    const table = fuseTable({ platform: "darwin", shipped: true });
    expect(fuseProblems(readWire(binary(shippedMac)), table)).toEqual([]);
    expect(fuseProblems(readWire(binary(DEFAULTS)), table)).toEqual([
      "EnableNodeOptionsEnvironmentVariable is on, not off",
      "EnableNodeCliInspectArguments is on, not off",
      "EnableEmbeddedAsarIntegrityValidation is off, not on",
      "OnlyLoadAppFromAsar is off, not on",
    ]);
    const local = readWire(binary(set(shippedMac, { 3: ON })));
    expect(fuseProblems(local, table)).toEqual(["EnableNodeCliInspectArguments is on, not off"]);
    expect(fuseProblems(local, fuseTable({ platform: "darwin", shipped: false }))).toEqual([]);
    // a removed fuse, a short wire, another version or no wire at all is never taken for a match
    expect(fuseProblems(readWire(binary(set(shippedMac, { 0: 114 }))), table)).toEqual(["RunAsNode is in state 114, not on"]);
    expect(fuseProblems(readWire(binary([ON, OFF])), table)).toContain("OnlyLoadAppFromAsar is missing, not on");
    expect(fuseProblems({ version: 2, states: shippedMac }, table)).toEqual(["unknown fuse wire version 2"]);
    expect(() => readWire(Buffer.from("no wire here"))).toThrow(/no fuse wire/);
  });

  it("reads both wires of a universal binary, which must agree, and turns only the inspect fuse back on (Linux CI's test copy)", () => {
    expect(readWire(binary(shippedMac, 2)).states).toEqual(shippedMac);
    const mixed = Buffer.concat([binary(shippedMac), binary(DEFAULTS)]);
    expect(() => readWire(mixed)).toThrow(/disagree/);
    expect(readWire(makeInspectable(binary(shippedMac, 2))).states).toEqual(set(shippedMac, { 3: ON }));
  });

  it("reads the real Electron binary the packages start from: Electron's defaults", () => {
    expect(fuseFile("/x/Terno.app")).toBe("/x/Terno.app/Contents/Frameworks/Electron Framework.framework/Electron Framework");
    const file = process.platform === "darwin" ? fuseFile(join(electronDist, "Electron.app")) : join(electronDist, "electron");
    const wire = readWire(readFileSync(file));
    expect(wire.version).toBe(1);
    expect(wire.states.slice(0, 8)).toEqual(DEFAULTS.slice(0, 8));
  });

  it("only a release ships: its build steps set TERNO_SHIPPED, every package's config carries the fuses, and a test build is never shipped", () => {
    expect(STEP_ENV).toEqual({ TERNO_RELEASE: "1", TERNO_SHIPPED: "1" });
    // this run's environment packages an inspectable build
    expect(process.env.TERNO_SHIPPED).toBeUndefined();
    expect(commonConfig("darwin").electronFuses).toEqual(fuseTable({ platform: "darwin", shipped: false }));
    expect(commonConfig("linux").electronFuses).toEqual(fuseTable({ platform: "linux", shipped: false }));
    const scripts = join(__dirname, "../scripts");
    const stage = readFileSync(join(scripts, "package-stage.mjs"), "utf8");
    expect(stage).toContain('export const shipped = process.env.TERNO_SHIPPED === "1";');
    expect(stage).toMatch(/if \(shipped && testBuild\) throw/);
    expect(readFileSync(join(scripts, "package.mjs"), "utf8")).toContain('assertFuses(app, { platform: "darwin", shipped });');
    expect(readFileSync(join(scripts, "package-linux.mjs"), "utf8")).toContain('assertFuses(join(dir, executableName), { platform: "linux", shipped });');
    const release = readFileSync(join(scripts, "release.mjs"), "utf8");
    expect(release).toContain('assertShipped(app, "darwin");');
    expect(release).toContain('assertShipped(join(dir, "opt/Terno/terno"), "linux");');
    expect(release).toContain("env: { ...process.env, ...STEP_ENV }");
  });
});

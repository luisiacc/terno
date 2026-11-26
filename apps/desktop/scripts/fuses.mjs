// Plan 283 (CASA 6.2.1): the Electron fuses every package carries, and the check that reads them back from the
// built binary. A shipped build (release.mjs) has Node's inspector off; an inspectable one (`pnpm dist:mac`, update
// test builds) keeps only that on, so Playwright can attach for the smoke suite. Main's DevTools-protocol rule follows
// the same fuse (src/debugging.ts), so nothing else differs between the two.
//
// The wire is read here, without a dependency (release.mjs's draft job installs none): Electron's sentinel, a version
// byte, a length byte, then one byte per fuse, as @electron/fuses reads it (`npx @electron/fuses read --app <path>`).
//
// `node fuses.mjs check <app or binary> shipped|inspectable` fails unless the wire matches the table;
// `node fuses.mjs inspectable <binary>` turns the inspect fuse back on in a throwaway installed copy (Linux CI's smoke).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const ON = 49;
const OFF = 48;
/** each fuse's place on the V1 wire, by electron-builder's `electronFuses` key */
export const WIRE = {
  runAsNode: { index: 0, name: "RunAsNode" },
  enableNodeOptionsEnvironmentVariable: { index: 2, name: "EnableNodeOptionsEnvironmentVariable" },
  enableNodeCliInspectArguments: { index: 3, name: "EnableNodeCliInspectArguments" },
  enableEmbeddedAsarIntegrityValidation: { index: 4, name: "EnableEmbeddedAsarIntegrityValidation" },
  onlyLoadAppFromAsar: { index: 5, name: "OnlyLoadAppFromAsar" },
};

/**
 * electron-builder's `electronFuses` for a platform and kind. RunAsNode stays on: the agents' connector
 * (resources/bin/terno-mcp) runs the app's binary as Node, and plan 283 says why it isn't moved yet. Embedded asar
 * integrity is Electron's on macOS and Windows only; Linux leaves it at its default.
 */
export function fuseTable({ platform, shipped }) {
  return {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: !shipped,
    ...(platform === "darwin" ? { enableEmbeddedAsarIntegrityValidation: true } : {}),
    onlyLoadAppFromAsar: true,
  };
}

/** The file that holds the wire: an .app's Electron Framework, or the executable itself (Linux). */
export function fuseFile(path) {
  if (path.endsWith(".app")) return join(path, "Contents/Frameworks/Electron Framework.framework/Electron Framework");
  return path;
}

/** Where each wire starts in `binary` (two in a universal Mach-O); throws when there's none. */
function wireOffsets(binary) {
  const offsets = [];
  for (let at = binary.indexOf(SENTINEL); at !== -1; at = binary.indexOf(SENTINEL, at + 1)) offsets.push(at + SENTINEL.length);
  if (!offsets.length) throw new Error("no fuse wire in this binary");
  return offsets;
}

/** The wire, `{ version, states }`; every copy in a universal binary must agree. */
export function readWire(binary) {
  const wires = wireOffsets(binary).map((at) => ({ version: binary[at], states: [...binary.subarray(at + 2, at + 2 + binary[at + 1])] }));
  if (wires.some((w) => JSON.stringify(w) !== JSON.stringify(wires[0]))) throw new Error("the binary's fuse wires disagree");
  return wires[0];
}

/** Every fuse in `table` the wire doesn't hold, by its name; empty when it matches. */
export function fuseProblems(wire, table) {
  if (wire.version !== 1) return [`unknown fuse wire version ${wire.version}`];
  return Object.entries(table).flatMap(([key, want]) => {
    const { index, name } = WIRE[key];
    const got = wire.states[index];
    if (got === (want ? ON : OFF)) return [];
    return [`${name} is ${got === ON ? "on" : got === OFF ? "off" : got === undefined ? "missing" : `in state ${got}`}, not ${want ? "on" : "off"}`];
  });
}

/** Reads the wire from an .app or an executable and throws unless it is the table for `platform` and `shipped`. */
export function assertFuses(path, { platform, shipped }) {
  const problems = fuseProblems(readWire(readFileSync(fuseFile(path))), fuseTable({ platform, shipped }));
  const kind = shipped ? "a shipped" : "an inspectable";
  if (problems.length) throw new Error(`${path} isn't fused as ${kind} build: ${problems.join("; ")}`);
  console.log(`✓ ${path}: fused as ${kind} build`);
}

/** Turns the inspect fuse on in `binary` (a copy), in place. */
export function makeInspectable(binary) {
  for (const at of wireOffsets(binary)) binary[at + 2 + WIRE.enableNodeCliInspectArguments.index] = ON;
  return binary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, path, kind] = process.argv.slice(2);
  if (command === "check" && path && (kind === "shipped" || kind === "inspectable")) {
    assertFuses(path, { platform: process.platform, shipped: kind === "shipped" });
  } else if (command === "inspectable" && path) {
    // only a test copy: the packages a release keeps are never changed. A macOS copy would need signing again (a new
    // identity for the keychain), so there an inspectable build is packaged instead
    if (process.platform === "darwin") throw new Error("on macOS, package an inspectable build (`pnpm dist:mac`) rather than changing a signed copy");
    assertFuses(path, { platform: process.platform, shipped: true });
    writeFileSync(path, makeInspectable(readFileSync(path)));
    assertFuses(path, { platform: process.platform, shipped: false });
  } else {
    console.error("usage: fuses.mjs check <app or binary> shipped|inspectable | fuses.mjs inspectable <binary>");
    process.exit(2);
  }
}

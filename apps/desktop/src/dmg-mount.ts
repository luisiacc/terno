// Plan 19: package.mjs attaches the DMG to give its volume Terno's icon and to
// check it. Plain TypeScript (no enums, no parameter properties): package.mjs
// imports it with Node's type stripping.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Run = (cmd: string, args: string[]) => unknown;

const hdiutil: Run = (cmd, args) => execFileSync(cmd, args, { stdio: "ignore" });

/**
 * Attaches a disk image under a private directory (never /Volumes, never in
 * Finder), runs `use` on its volume, and always detaches whatever got mounted
 * there: also when attaching, finding the volume or `use` fails. The directory
 * is removed only once empty, so a failed detach never deletes into a volume.
 */
export function withMounted(image: string, readonly: boolean, use: (volume: string) => void, run: Run = hdiutil): void {
  const parent = mkdtempSync(join(tmpdir(), "terno-dmg-"));
  try {
    run("hdiutil", ["attach", image, "-nobrowse", "-noautoopen", ...(readonly ? ["-readonly"] : []), "-mountrandom", parent]);
    const mounted = readdirSync(parent);
    if (mounted.length !== 1) throw new Error(`${image}: expected one mounted volume, found ${mounted.length}`);
    use(join(parent, mounted[0]!));
  } finally {
    for (const volume of readdirSync(parent)) {
      try {
        run("hdiutil", ["detach", join(parent, volume), "-force"]);
        rmdirSync(join(parent, volume));
      } catch {}
    }
    try {
      rmdirSync(parent);
    } catch {}
  }
}

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

/** Plan 226: what a mounted DMG volume needs to be a drag-to-install window, as a list of what's wrong (empty: fine). */
export interface VolumeView {
  isDir(path: string): boolean;
  /** a symlink's target, or null when it isn't one */
  link(path: string): string | null;
  exists(path: string): boolean;
  /** a folder's entries, hidden ones too */
  list(path: string): string[];
  /** the folder's Finder flags say it has a custom icon (the volume's .VolumeIcon.icns shows) */
  customIcon(path: string): boolean;
}

export function dmgProblems(volume: string, app: string, v: VolumeView): string[] {
  const problems: string[] = [];
  if (!v.isDir(join(volume, `${app}.app`))) problems.push(`no ${app}.app at its root`);
  if (v.link(join(volume, "Applications")) !== "/Applications") problems.push("no Applications link to /Applications");
  if (!v.exists(join(volume, ".VolumeIcon.icns")) || !v.customIcon(volume)) problems.push("the volume has no icon");
  // dmgbuild keeps it at the root as .background.tiff (Finder's own way is a .background folder)
  if (!v.list(volume).some((name) => name.startsWith(".background"))) problems.push("no background image");
  if (!v.exists(join(volume, ".DS_Store"))) problems.push("no window layout (.DS_Store)");
  return problems;
}

/** com.apple.FinderInfo as hex: fdFlags is bytes 8–9, big-endian; kHasCustomIcon is 0x0400. */
export function hasCustomIconFlag(finderInfoHex: string): boolean {
  const bytes = finderInfoHex.replace(/\s+/g, "");
  if (bytes.length < 20) return false;
  return (parseInt(bytes.slice(16, 18), 16) & 0x04) !== 0;
}

/** Runs `step` up to `tries` times, `cleanup` and a wait between tries: a hosted runner's hdiutil is sometimes briefly busy. */
export async function withRetries<T>(step: () => Promise<T>, o: { tries: number; waitMs: number; label: string; cleanup?: () => void; sleep?: (ms: number) => Promise<void>; warn?: (m: string) => void }): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = o.warn ?? ((m: string) => console.warn(m));
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (attempt >= o.tries) throw e;
      warn(`! ${o.label} failed (attempt ${attempt} of ${o.tries}), retrying: ${(e as Error).message}`);
      o.cleanup?.();
      await sleep(o.waitMs);
    }
  }
}

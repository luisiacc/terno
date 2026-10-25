import type { SectionReader } from "../instant/snapshot";
import type { SliceClock } from "../instant/slices";

/** A strings section decoded in slices (a hundred thousand addresses at once would stall the loop). */
export async function readStrings(s: SectionReader, name: string, clock: SliceClock): Promise<string[]> {
  const lens = s.u32(`${name}.len`);
  const chars = s.u16(`${name}.chars`);
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < lens.length; i++) {
    const end = at + lens[i]!;
    if (end > chars.length) throw new Error("snapshot strings truncated");
    // short strings: fromCharCode over a subarray, no intermediate array
    out.push(String.fromCharCode.apply(null, chars.subarray(at, end) as unknown as number[]));
    at = end;
    if ((i & 4095) === 0) await clock.tick();
  }
  if (at !== chars.length) throw new Error("snapshot strings misaligned");
  return out;
}


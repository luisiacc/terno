import type { Gap } from "../../db/src/test/timing";

export interface LoadCommandSpan {
  name: string;
  n: number | undefined;
  start: number;
  end: number;
  cpu: number;
  spent: number;
  active: number;
  injected: number;
}

/** Post-measure evidence only; never used to classify a gap or adjust a list time. */
export function loadFailureDetail(gaps: readonly Gap[], commands: readonly LoadCommandSpan[], descheduled: readonly Gap[]) {
  const retained = gaps.slice(0, 16).map((gap) => {
    const overlapping: (LoadCommandSpan & { id: number })[] = [];
    let overlapCount = 0;
    for (let id = 0; id < commands.length; id++) {
      const r = commands[id]!;
      if (r.start >= gap.end || r.end <= gap.start) continue;
      overlapCount++;
      if (overlapping.length < 16) overlapping.push({ id, name: r.name.slice(0, 64), n: r.n, start: r.start, end: r.end, cpu: r.cpu, spent: r.spent, active: r.active, injected: r.injected });
    }
    return { start: gap.start, end: gap.end, wall: gap.wall, busy: gap.busy, cpu: gap.cpu, descheduled: descheduled.includes(gap), overlapCount, omittedCommands: overlapCount - overlapping.length, commands: overlapping };
  });
  return { gapCount: gaps.length, omittedGaps: gaps.length - retained.length, gaps: retained };
}

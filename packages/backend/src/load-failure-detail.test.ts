import { expect, it } from "vitest";
import { loadFailureDetail, type LoadCommandSpan } from "./load-failure-detail";
import type { Gap } from "../../db/src/test/timing";

const gap: Gap = { start: 10, end: 62, wall: 52, busy: 51.97, cpu: 6 };
const command = (start: number, end: number): LoadCommandSpan => ({ name: "trainMoveSlice", n: 4, start, end, cpu: 2.1, spent: 9, active: 14, injected: 0 });

it("retains exact intervals and original command indices without attributing outside time", () => {
  const runs = [command(0, 10), command(25, 39), command(62, 70)];
  const before = JSON.stringify({ gap, runs });
  expect(loadFailureDetail([gap], runs, [])).toEqual({ gapCount: 1, omittedGaps: 0, gaps: [{ ...gap, descheduled: false, overlapCount: 1, omittedCommands: 0, commands: [{ id: 1, ...runs[1] }] }] });
  expect(loadFailureDetail([gap], runs, [gap]).gaps[0]).toMatchObject({ descheduled: true });
  expect(JSON.stringify({ gap, runs })).toBe(before);
});

it("bounds retained gaps, overlapping commands and names, reports truncation, and copies only timing fields", () => {
  const runs = Array.from({ length: 1_000 }, () => ({ ...command(11, 61), name: "x".repeat(100_000), secret: "never serialize arbitrary properties" }));
  const detail = loadFailureDetail(Array.from({ length: 100 }, () => gap), runs, []);
  expect(detail.gaps).toHaveLength(16);
  expect(detail.omittedGaps).toBe(84);
  expect(detail.gaps[0]).toMatchObject({ overlapCount: 1_000, omittedCommands: 984 });
  const encoded = JSON.stringify(detail);
  expect(encoded.length).toBeLessThan(100_000);
  expect(encoded).not.toContain("secret");
  expect(encoded).not.toContain("x".repeat(65));
});

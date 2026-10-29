/**
 * Plan 65 (Codex R4): a renamed folder's messages are recognised by envelope from an index built once: each taken
 * once, oldest first, never one already claimed. Its timing at scale is in adopt.perf.test.ts.
 */
import { expect, it } from "vitest";
import { AdoptIndex } from "./adopt";

it("a candidate the folder already holds is passed over; a dropped one is never taken", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 1, ...e }, { id: 2, ...e }, { id: 3, ...e }]);
  index.drop(2);
  expect(await index.take(e, async (id) => id !== 1)).toBe(3);
  expect(await index.take(e, async () => true)).toBeNull();
});

it("Codex R12: a candidate added later, older than ones still waiting, is taken in its place", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 5, ...e }, { id: 9, ...e }]);
  expect(await index.take(e, async () => true)).toBe(5);
  await index.add([7, 3], async (ids) => ids.map((id) => ({ id, ...e })));
  expect(await index.take(e, async () => true)).toBe(3);
  expect(await index.take(e, async () => true)).toBe(7);
  expect(await index.take(e, async () => true)).toBe(9);
});

it("Codex R13: a candidate taken or found by its own key is never one again, even if a reset lists it later", async () => {
  const e = { subject: "S", fromEmail: "a@x", date: 1, size: 1, rfcMessageId: null };
  const index = new AdoptIndex([{ id: 1, ...e }, { id: 2, ...e }]);
  expect(await index.take(e, async () => true)).toBe(1);
  index.drop(2);
  await index.add([1, 2, 3], async (ids) => ids.map((id) => ({ id, ...e })));
  expect(await index.take(e, async () => true)).toBe(3);
  expect(await index.take(e, async () => true)).toBeNull();
});

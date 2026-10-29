/**
 * Plan 65 (Codex R17): a provider's catalog of 10,000 folders, names of 225 characters sharing a long prefix, becomes
 * the folder list within a small part of a frame on the backend's loop (no sort there: the sidebar draws by name).
 */
import { FOLDER_NAME_MAX } from "@terno/core";
import { expect, it } from "vitest";
import { labelFolders } from "./gmail-api";
import { customFolders, distinctCandidates, planTellApart } from "./imap";

const prefix = "Proyectos y clientes de la oficina central — ".repeat(5);
const name = (i: number) => `${prefix}${String((i * 7919) % 10_000).padStart(5, "0")}`.slice(-FOLDER_NAME_MAX);
const best = (fn: () => unknown) => {
  fn();
  const runs = [0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  });
  return Math.min(...runs);
};

it("Gmail: 10,000 long labels in under 8 ms", () => {
  const labels = Array.from({ length: 10_000 }, (_, i) => ({ id: `Label_${i}`, name: name(i), type: "user" }));
  expect(labelFolders(labels)).toHaveLength(10_000);
  expect(best(() => labelFolders(labels))).toBeLessThan(8);
});

it("IMAP: 10,000 long folders in under 8 ms", () => {
  type Listed = Parameters<typeof customFolders>[0][number];
  const list = Array.from({ length: 10_000 }, (_, i) => ({ path: name(i), name: name(i), delimiter: "/", flags: new Set<string>(), listed: true, subscribed: true }) as unknown as Listed);
  expect(customFolders(list, {})).toHaveLength(10_000);
  expect(best(() => customFolders(list, {}))).toBeLessThan(8);
});

it("Codex R21: 5,000 held-back messages sharing 5,000 twins: their candidates gathered once, in under 10 ms", () => {
  const shared = Array.from({ length: 5000 }, (_, i) => i + 1);
  const list = Array.from({ length: 5000 }, () => ({ candidates: shared }));
  expect(distinctCandidates(list)).toHaveLength(5000);
  expect(best(() => distinctCandidates(list))).toBeLessThan(10);
});

it("Codex R30: 5,000 copies of a Message-ID with 5,000 placed twins are planned in linear time, under 20 ms", () => {
  const candidates = Array.from({ length: 5000 }, (_, i) => i + 1);
  const places = new Map(candidates.map((id) => [id, [{ mailbox: "Z", uid: id }]]));
  const present = new Set(candidates.map((id) => `Z\u0000${id}`));
  const list = Array.from({ length: 5000 }, () => ({ candidates, path: "A", attachTo: 1, idCopy: true, old: false }));
  const plan = planTellApart(list, places, present);
  // each twin gains its place in A once; nothing is a copy of its own, nothing moved
  expect(plan.placed.map((p) => p.id)).toEqual(candidates);
  expect(plan.placed.every((p) => !p.moved)).toBe(true);
  expect(plan.copies).toHaveLength(0);
  expect(best(() => planTellApart(list, places, present))).toBeLessThan(20);
});

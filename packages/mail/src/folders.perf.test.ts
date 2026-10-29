/**
 * Plan 65 (Codex R17): a provider's catalog of 10,000 folders, names of 225 characters sharing a long prefix, becomes
 * the folder list within a small part of a frame on the backend's loop (no sort there: the sidebar draws by name).
 */
import { FOLDER_NAME_MAX } from "@terno/core";
import { expect, it } from "vitest";
import { labelFolders } from "./gmail-api";
import { customFolders, distinctCandidates } from "./imap";

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

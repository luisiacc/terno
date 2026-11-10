import { beforeEach, expect, it, vi } from "vitest";

/** Plan 177: pin and unpin, the toggle for P, the "select all N" guard, and an Undo that puts back exactly what changed. */

const calls: { method: string; params: Record<string, unknown> }[] = [];
let answer: (method: string, params: Record<string, unknown>) => unknown = () => ({});
vi.mock("~/rpc/connection", () => ({
  client: {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return answer(method, params);
    },
  },
}));
const undos: (() => unknown)[] = [];
const said: string[] = [];
vi.mock("~/lib/snack", () => ({
  registerUndo: (run: () => unknown) => {
    undos.push(run);
    return {};
  },
  snack: Object.assign((m: string) => void said.push(m), { success: (m: string) => void said.push(m), error: (m: string) => void said.push(`error: ${m}`) }),
}));
const target: { value: { ids: number[] } | { scope: unknown } } = { value: { ids: [] } };
vi.mock("~/lib/select", () => ({ currentTargets: () => target.value }));
vi.mock("~/lib/page", () => ({ listCovered: () => false }));

const { pinThreads, togglePin, unpinThreads } = await import("./pins");
const { usePins } = await import("~/state/pins");

const pin = (threadId: number, pinnedAt = 100) => ({ threadId, pinnedAt });

beforeEach(() => {
  calls.length = 0;
  undos.length = 0;
  said.length = 0;
  usePins.setState({ ids: new Set([2]), loaded: true });
  answer = (method, params) => {
    const ids = params.threadIds as number[];
    if (method === "pins.add") return { added: ids.filter((id) => id !== 2).map((id) => pin(id)) };
    if (method === "pins.remove") return { removed: ids.filter((id) => id === 2).map((id) => pin(id, 50)) };
    return { ok: true };
  };
});

it("P pins a mixed selection (the unpinned among it), and its Undo takes away exactly what it pinned", async () => {
  target.value = { ids: [1, 2] };
  togglePin();
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["pins.add"]));
  expect(calls[0]!.params.threadIds).toEqual([1, 2]);
  await vi.waitFor(() => expect(undos).toHaveLength(1));
  await undos[0]!();
  expect(calls.at(-1)).toEqual({ method: "pins.restore", params: { drop: [pin(1)], put: [] } });
});

it("P unpins when every target is pinned; Unpin from a mixed menu unpins, never toggles (Codex review of the plan, 7)", async () => {
  target.value = { ids: [2] };
  togglePin();
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["pins.remove"]));
  calls.length = 0;
  await unpinThreads([1, 2]);
  expect(calls.map((c) => c.method)).toEqual(["pins.remove"]);
  await undos.at(-1)!();
  expect(calls.at(-1)).toEqual({ method: "pins.restore", params: { drop: [], put: [pin(2, 50)] } });
});

it("a \"select all N\" pins nothing: the snack says to pick the conversations", async () => {
  target.value = { scope: { key: "k" } };
  togglePin();
  expect(await pinThreads()).toBe(false);
  expect(await unpinThreads()).toBe(false);
  expect(calls).toEqual([]);
  expect(said.every((m) => m.startsWith("Pick the conversations to pin"))).toBe(true);
  expect(said).toHaveLength(3);
});

it("refused (past the cap): an error snack, and no Undo", async () => {
  answer = () => {
    throw new Error("You can pin up to 100 conversations. Unpin one to pin another.");
  };
  expect(await pinThreads([1])).toBe(false);
  expect(undos).toHaveLength(0);
  expect(said[0]).toMatch(/^error: /);
});

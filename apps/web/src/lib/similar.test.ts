import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; params: unknown }[] = [];
let handlers: Record<string, (p: unknown) => Promise<unknown>> = {};
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return handlers[method]!(params);
    },
  },
}));
vi.mock("~/lib/actions", () => ({
  leaveList: () => undefined,
  trackJob: () => ({ jobId: "job", snackId: "job", stop: () => undefined }),
  undoAction: (undo: unknown, name: string) => ({ label: "Undo", name, undo }),
}));
vi.mock("~/state/list", () => ({ reloadList: () => Promise.resolve() }));
vi.mock("~/state/app", () => ({ setApp: () => undefined }));
vi.mock("~/lib/diag", () => ({ captureUi: () => undefined }));

const { applySimilar } = await import("./similar");
const { registerUndo, resetSnacks, runUndo, useSnack } = await import("./snack");

const scope = { kind: "sender", email: "a@b.com" } as const;
const applied = { affected: 3, skipped: 0, undoId: 7, filter: { id: 1, filterUndo: 9 }, filterFailed: false };

beforeEach(() => {
  calls.length = 0;
  handlers = {};
  resetSnacks();
});

describe("applySimilar's one Undo (plan 63)", () => {
  it("z before the sweep answers waits for it, then takes back the sweep, the filter and the original action", async () => {
    let answer!: (v: unknown) => void;
    handlers["similar.apply"] = () => new Promise((r) => (answer = r));
    handlers["similar.undo"] = async () => ({ restored: 3 });
    const original = registerUndo(async () => calls.push({ method: "original", params: null }));
    const running = applySimilar("spam", [], scope, { senderName: "B", original });
    const z = runUndo(useSnack.getState().undo!);
    answer(applied);
    await running;
    await z;
    expect(calls.map((c) => c.method)).toEqual(["similar.apply", "similar.undo", "original"]);
    expect(calls[1]!.params).toEqual({ undoId: 7, filterUndo: 9, jobId: undefined });
    // nothing left to offer: no result snack with a spent Undo
    expect(useSnack.getState().current).toBeNull();
  });

  it("a retry after the original's undo failed doesn't undo the sweep twice", async () => {
    handlers["similar.apply"] = async () => applied;
    handlers["similar.undo"] = async () => ({ restored: 3 });
    let fail = true;
    const original = registerUndo(async () => {
      calls.push({ method: "original", params: null });
      if (fail) throw new Error("offline");
    });
    await applySimilar("archive", [], scope, { senderName: "B", original });
    const undo = useSnack.getState().undo!;
    await expect(runUndo(undo)).rejects.toThrow("offline");
    fail = false;
    await runUndo(undo);
    expect(calls.map((c) => c.method)).toEqual(["similar.apply", "similar.undo", "original", "original"]);
    expect(undo.state).toBe("done");
  });
});

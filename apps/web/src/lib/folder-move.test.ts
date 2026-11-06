// @vitest-environment jsdom
import { RpcError } from "@terno/core/rpc";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

const calls: { method: string; params: unknown }[] = [];
let handlers: Record<string, (p: unknown) => Promise<unknown>> = {};
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 1,
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return handlers[method]!(params);
    },
    on: () => () => undefined,
  },
}));
const undone: number[][] = [];
vi.mock("~/lib/actions", () => ({
  deferred: <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  },
  targetRows: (ids: number[]) => ids.map((id) => ({ id, accountId: 1, inInbox: true, categoryIds: [] })),
  undoAction: (undo: unknown, name: string) => ({ label: "Undo", name, undo }),
  undoActions: async (ids: number[]) => void undone.push(ids),
}));
vi.mock("~/lib/categorize", () => ({ leaveView: () => undefined }));
vi.mock("~/lib/flash", () => ({ flashRows: () => undefined }));
vi.mock("~/state/app", () => ({ getApp: () => ({ accountId: 1, folder: null, view: "inbox", query: "", categories: [], checked: new Set() }), setApp: () => undefined }));
vi.mock("~/state/list", () => ({ patchRows: () => undefined, reloadList: () => Promise.resolve() }));
vi.mock("~/state/threads", () => ({ invalidateThreads: () => undefined }));

const { moveToFolder } = await import("./folder-move");
const { resetSnacks, runUndo, useSnack } = await import("./snack");

setLocale("en", en);
const to = { accountId: 1, key: "Label_A", name: "Recibos" };

beforeEach(() => {
  calls.length = 0;
  undone.length = 0;
  handlers = {};
  resetSnacks();
});

describe("a drop on a folder that fails partway (plan 127, Codex review)", () => {
  it("the failure's snack offers an Undo of what committed: the slices the backend names", async () => {
    handlers["folders.moveThreads"] = async () => {
      throw new RpcError("INTERNAL", "disk full", { undoId: 9 });
    };
    await moveToFolder(to, [1, 2]);
    const current = useSnack.getState().current!;
    expect(current.message).toContain("disk full");
    expect(current.action?.label).toBe("Undo");
    await runUndo(useSnack.getState().undo!);
    expect(undone).toEqual([[9]]);
  });

  it("calls that succeeded before the one that failed come back too", async () => {
    let n = 0;
    handlers["folders.moveThreads"] = async () => {
      if (n++ === 0) return { affected: 5000, kept: 0, undoId: 3 };
      throw new Error("offline");
    };
    await moveToFolder(to, Array.from({ length: 5001 }, (_, i) => i + 1));
    expect(useSnack.getState().current!.action?.label).toBe("Undo");
    await runUndo(useSnack.getState().undo!);
    expect(undone).toEqual([[3]]);
  });

  it("nothing committed: nothing to undo, only what went wrong", async () => {
    handlers["folders.moveThreads"] = async () => {
      throw new Error("offline");
    };
    await moveToFolder(to, [1]);
    expect(useSnack.getState().current!.action).toBeUndefined();
  });
});

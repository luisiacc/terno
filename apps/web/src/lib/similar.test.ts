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
// (snack speech reads whether single keys are on, plan 188)
vi.mock("~/state/app", () => ({ setApp: () => undefined, getApp: () => ({ settings: null }) }));
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

describe("plan 217: always is the default", () => {
  it("archive similar makes the rule too: the result says so and offers its edit, not Always", async () => {
    handlers["similar.apply"] = async () => applied;
    await applySimilar("archive", [], scope, { senderName: "B" });
    expect(calls[0]!.params).toMatchObject({ action: "archive", always: true, filterName: "Archive: a@b.com" });
    const current = useSnack.getState().current!;
    expect(current.description).toBe("Future mail like this is archived too.");
    expect(current.secondary).toMatchObject({ label: "Edit", name: "Edit the rule for future mail" });
  });

  it("a rule that couldn't be made says so, with no edit", async () => {
    handlers["similar.apply"] = async () => ({ ...applied, filter: null, filterFailed: true });
    await applySimilar("trash", [], scope, { senderName: "B" });
    const current = useSnack.getState().current!;
    expect(current.description).toBe("Couldn’t set up the rule for future mail. You can add it in Settings → Rules.");
    expect(current.secondary).toBeUndefined();
  });

  it("a sweep failing after its rule was made: Undo takes the rule back too", async () => {
    const { RpcError } = await import("@terno/core/rpc");
    handlers["similar.apply"] = async () => {
      throw new RpcError("INTERNAL", "disk full", { undoId: null, filterUndo: 4 });
    };
    handlers["similar.undo"] = async () => ({ restored: 0 });
    await applySimilar("archive", [], scope, { senderName: "B" });
    await runUndo(useSnack.getState().undo!);
    expect(calls[1]).toEqual({ method: "similar.undo", params: { undoId: null, filterUndo: 4, jobId: undefined } });
  });
});

describe("plan 158: an offer says what it will do", () => {
  const scope = {
    sender: { kind: "sender", email: "a@xataka.com" },
    subject: { kind: "subject", email: "a@xataka.com", subject: "291 gadgets que cambiarán tu escritorio para siempre" },
    domain: { kind: "domain", domain: "xataka.com" },
    list: { kind: "list", listId: "abc123.list-id.xataka.com" },
  } as const;

  it("a sentence, the verb first; the subject is the mail's own, never a rule's #; a list isn't its id", async () => {
    const { offerSentence } = await import("./similar");
    const of = (s: (typeof scope)[keyof typeof scope], count = 5, capped = false) => ({ scope: s, count, capped });
    expect(offerSentence("archive", of(scope.sender), "Xataka")).toBe("Archive 5 more from Xataka");
    expect(offerSentence("trash", of(scope.domain, 1000, true), null)).toBe("Delete 1,000+ more from @xataka.com");
    expect(offerSentence("spam", of(scope.list), null)).toBe("Mark 5 more from this mailing list as spam");
    const subject = offerSentence("archive", of(scope.subject), "Xataka");
    expect(subject).toMatch(/^Archive 5 more like “291 gadgets/);
    expect(subject).not.toContain("#");
    // nothing counted yet: no "0"
    expect(offerSentence("archive", of(scope.sender, 0, true), "Xataka")).toBe("Archive everything from Xataka");
  });
});

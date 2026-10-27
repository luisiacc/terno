import { expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call: rpc.call, on: () => () => {} } }));
vi.mock("~/state/threads", () => ({ invalidateThreads: vi.fn(), loadThread: vi.fn() }));
const { sendDraft } = await import("./compose");
const drafts = await import("./drafts");
const { newFields } = await import("./compose-fields");
const app = await import("~/state/app");
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

it.each([true, false])("reserves Send before synchronous subscriber reentry (reenter=%s)", async (reenter) => {
  const previous = app.getApp(); app.setApp({ accounts: [{ id: 1, email: "me@example.test" } as import("@terno/core").Account] });
  const key = drafts.createDraft({ ...newFields(1), toText: "person@example.test", bodyText: "preserved" });
  const gate = deferred<{ threadId: number }>(), entered = deferred<void>(); let calls = 0, nested: Promise<boolean> | undefined, triggered = false;
  rpc.call.mockImplementation(async (method: string) => { if (method === "compose.send") { calls++; entered.resolve(); return gate.promise; } return []; });
  const off = drafts.useDrafts.subscribe((state, prev) => {
    if (reenter && !triggered && !prev.drafts[key]?.sending && state.drafts[key]?.sending) { triggered = true; nested = sendDraft(key); }
  });
  let first: Promise<boolean> | undefined;
  try {
    first = sendDraft(key);
    await entered.promise;
    expect(triggered).toBe(reenter);
    if (reenter) expect(nested).toBe(first);
    expect(calls).toBe(1);
    expect(drafts.useDrafts.getState().drafts[key]!.sending).toBe(true);
    expect(drafts.editDraft(key, { bodyText: "must not land" })).toBe(false);
    gate.reject(new Error("offline"));
    expect(await first).toBe(false);
    if (nested) expect(await nested).toBe(false);
    expect(drafts.useDrafts.getState().drafts[key]).toMatchObject({ bodyText: "preserved", sending: false });
  } finally { off(); gate.reject(new Error("cleanup")); await Promise.allSettled([first, nested].filter((p): p is Promise<boolean> => !!p)); drafts.forgetDraft(key); app.useApp.setState(previous, true); rpc.call.mockReset(); }
});

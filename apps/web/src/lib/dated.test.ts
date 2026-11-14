/** Plan 204 §6, the Codex code review: the 14-day check's yes is kept only once the check is queued. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let fail = false;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string) => {
      calls.push(method);
      return fail ? Promise.reject(new Error("The backend is busy.")) : Promise.resolve({ queued: 3 });
    },
  },
}));
const errors: string[] = [];
vi.mock("~/lib/snack", () => ({ registerUndo: () => null, snack: { success: () => {}, error: (m: string) => errors.push(m) } }));

const { answerScan } = await import("./dated");

beforeEach(() => {
  calls.length = 0;
  errors.length = 0;
  fail = false;
});

describe("the 14-day check's answer", () => {
  it("yes: queued, then answered", async () => {
    const save = vi.fn(async () => {});
    expect(await answerScan(true, save)).toBe(true);
    expect(calls).toEqual(["dated.scan"]);
    expect(save).toHaveBeenCalledWith({ scanAnswered: true });
  });

  it("a yes that fails isn't saved: it says so, and the offer stays", async () => {
    fail = true;
    const save = vi.fn(async () => {});
    expect(await answerScan(true, save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(errors).toEqual(["The backend is busy."]);
  });

  it("not now: answered, nothing queued", async () => {
    const save = vi.fn(async () => {});
    await answerScan(false, save);
    expect(calls).toEqual([]);
    expect(save).toHaveBeenCalledWith({ scanAnswered: true });
  });
});

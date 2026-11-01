/**
 * Plan 102: an account edit is shown at once; overlapping edits of a field never let an older answer or rollback
 * overwrite a newer one, and an `accounts` event mid-save keeps what's still on its way (Codex R7).
 */
import type { Account } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { params: { id: number } & Record<string, unknown>; settle: (error?: Error) => void }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (_method: string, params: { id: number } & Record<string, unknown>) =>
      new Promise((resolve, reject) => {
        // the backend keeps what it saved: a later answer carries it
        calls.push({ params, settle: (e) => {
          if (e) return reject(e);
          stored.set(params.id, { ...stored.get(params.id), ...strip(params) });
          resolve({ ...base(params.id), ...stored.get(params.id) });
        } });
      }),
    on: () => () => {},
  },
}));

const stored = new Map<number, Partial<Account>>();
const strip = ({ id: _id, ...rest }: Record<string, unknown>) => rest;
const base = (id: number): Account => ({ id, kind: "imap", email: `a${id}@example.com`, displayName: `A${id}`, color: "indigo", senderName: "", signature: "", syncWindowDays: null, syncState: { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null } });

const { patchAccount, resetAccountEdits, withPendingEdits } = await import("./accounts");
const { getApp, setApp } = await import("~/state/app");
const name = (id = 1) => getApp().accounts.find((a) => a.id === id)?.displayName;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  stored.clear();
  resetAccountEdits();
  setApp({ accounts: [base(1), base(2)] });
});

describe("patchAccount", () => {
  it("shows the edit at once and keeps the backend's account after", async () => {
    const done = patchAccount(1, { displayName: "Work" });
    expect(name()).toBe("Work");
    calls[0]!.settle();
    await done;
    expect(name()).toBe("Work");
    expect(name(2)).toBe("A2");
  });

  it("a failure puts the old name back and rejects", async () => {
    const done = patchAccount(1, { displayName: "Work" });
    calls[0]!.settle(new Error("disk full"));
    await expect(done).rejects.toThrow("disk full");
    expect(name()).toBe("A1");
  });

  it("answers land in the order the backend saved them: the last saved name shows", async () => {
    const first = patchAccount(1, { displayName: "One" });
    const second = patchAccount(1, { displayName: "Two" });
    calls[0]!.settle();
    await first;
    // "Two" is still on its way: it keeps showing
    expect(name()).toBe("Two");
    calls[1]!.settle();
    await second;
    expect(name()).toBe("Two");
  });

  it("an older edit's failure doesn't undo a newer one; a newer failure goes back to what was shown before it", async () => {
    const first = patchAccount(1, { displayName: "One" });
    const second = patchAccount(1, { displayName: "Two" });
    calls[1]!.settle();
    await second;
    calls[0]!.settle(new Error("no"));
    await expect(first).rejects.toThrow();
    expect(name()).toBe("Two");

    const third = patchAccount(1, { displayName: "Three" });
    calls[2]!.settle(new Error("no"));
    await expect(third).rejects.toThrow();
    expect(name()).toBe("Two");
  });

  it("edits of different fields don't touch each other", async () => {
    const rename = patchAccount(1, { displayName: "Work" });
    const recolor = patchAccount(1, { color: "rose" });
    calls[0]!.settle(new Error("no"));
    await expect(rename).rejects.toThrow();
    expect(getApp().accounts[0]).toMatchObject({ displayName: "A1", color: "rose" });
    calls[1]!.settle();
    await recolor;
    expect(getApp().accounts[0]).toMatchObject({ displayName: "A1", color: "rose" });
  });

  it("an accounts event mid-save keeps the edit on its way; after the answer it's the backend's", async () => {
    const done = patchAccount(1, { displayName: "Work" });
    expect(withPendingEdits([base(1), base(2)]).map((a) => a.displayName)).toEqual(["Work", "A2"]);
    // nothing pending for an account: the same objects back
    const others = [base(2)];
    expect(withPendingEdits(others)[0]).toBe(others[0]);
    calls[0]!.settle();
    await done;
    await tick();
    expect(withPendingEdits([base(1)])[0]!.displayName).toBe("A1");
  });

  it("two renames that both fail show the backend's name, not the first unsaved one (Codex code review #1)", async () => {
    const one = patchAccount(1, { displayName: "One" });
    const two = patchAccount(1, { displayName: "Two" });
    expect(name()).toBe("Two");
    calls[0]!.settle(new Error("no"));
    await expect(one).rejects.toThrow();
    expect(name()).toBe("Two");
    calls[1]!.settle(new Error("no"));
    await expect(two).rejects.toThrow();
    expect(name()).toBe("A1");
  });

  it("another field's answer, carrying the stored name, keeps a rename still on its way (Codex code review #3)", async () => {
    const rename = patchAccount(1, { displayName: "Work" });
    const recolor = patchAccount(1, { color: "rose" });
    // the color's answer is the backend's account before the rename landed
    calls[1]!.settle();
    await recolor;
    expect(getApp().accounts[0]).toMatchObject({ displayName: "Work", color: "rose" });
    calls[0]!.settle();
    await rename;
    expect(getApp().accounts[0]).toMatchObject({ displayName: "Work", color: "rose" });
  });

  it("an account removed while saving stays removed", async () => {
    const done = patchAccount(1, { displayName: "Work" });
    setApp({ accounts: [base(2)] });
    calls[0]!.settle();
    await done;
    expect(getApp().accounts.map((a) => a.id)).toEqual([2]);
  });
});

/**
 * Plan 25's renderer state, in Node with the RPC client mocked: an incident (Later, the send notice)
 * ends when the account works again; an attempt's result counts only while it's the latest.
 */
import type { Account } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; params: unknown; settle: (error?: Error) => void }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => new Promise<void>((resolve, reject) => calls.push({ method, params, settle: (e) => (e ? reject(e) : resolve()) })),
    on: () => () => {},
  },
}));

const { accountsChanged, announceParkedSend, noticeAccounts, putOff, requestSignIn, resetSignIn, signInAgain, useSignIn } = await import("./sign-in");
const { dismissSnack, resetSnacks, snack, useSnack } = await import("./snack");

const account = (id: number, authRequired: boolean, kind: "imap" | "gmail" = "imap"): Account =>
  ({ id, kind, email: `a${id}@example.com`, displayName: `A${id}`, color: "indigo", syncState: { status: authRequired ? "error" : "idle", authRequired } }) as unknown as Account;

beforeEach(() => {
  setLocale("en", en);
  resetSignIn();
  resetSnacks();
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("the incident", () => {
  it("Later hides the notice until that account works again; then a new refusal is news", () => {
    const later = () => useSignIn.getState().later;
    putOff([1, 2]);
    expect(noticeAccounts([account(1, true), account(2, true), account(3, true)], later()).map((a) => a.id)).toEqual([3]);
    // 1 signed in (or came back on its own); 2 still waits
    accountsChanged([account(1, false), account(2, true)]);
    expect([...later()]).toEqual([2]);
    expect(noticeAccounts([account(1, true), account(2, true)], later()).map((a) => a.id)).toEqual([1]);
  });

  it("a parked send is announced once per incident; recovery withdraws it, even while queued behind another snack", () => {
    announceParkedSend(account(1, true));
    announceParkedSend(account(1, true));
    expect(useSnack.getState().current?.message).toBe("Your message will go out once you sign in to a1@example.com");
    // the user's own snack holds the dock; a second account's notice queues behind it
    const mine = snack("Archived", { action: { label: "Undo", onClick: () => {} } });
    announceParkedSend(account(2, true));
    accountsChanged([account(1, true), account(2, false)]);
    // the queued one went with its incident: when the user's snack goes, nothing about account 2 follows
    dismissSnack(mine);
    expect(useSnack.getState().current).toBeNull();
    expect(useSignIn.getState().announced.has(2)).toBe(false);
    announceParkedSend(account(2, true));
    expect(useSignIn.getState().announced.has(2)).toBe(true);
  });

  it("Sign in from elsewhere opens the panel even after Later", () => {
    putOff([1]);
    requestSignIn(1);
    expect(useSignIn.getState().later.has(1)).toBe(false);
    expect(useSignIn.getState().request).toMatchObject({ accountId: 1, seq: 1 });
  });
});

describe("attempts", () => {
  it("a superseded attempt's failure says nothing (Open again, an abandoned page timing out)", async () => {
    const a = account(1, true, "gmail");
    const first = signInAgain(a);
    const second = signInAgain(a);
    calls[0]!.settle(new RpcError("BAD_REQUEST", "Sign-in cancelled."));
    expect(await first).toBe(false);
    expect(useSignIn.getState().attempts.get(1)).toMatchObject({ busy: true, error: null });
    calls[1]!.settle();
    expect(await second).toBe(true);
    expect(useSignIn.getState().attempts.has(1)).toBe(false);
    expect(useSnack.getState().current?.message).toBe("a1@example.com is connected again");
  });

  it("Codex review #8: a healthy account's wrong password keeps its error (and says it plainly)", async () => {
    const pending = signInAgain(account(1, false), "wrong");
    expect(calls[0]).toMatchObject({ method: "accounts.reconnect", params: { id: 1, password: "wrong" } });
    calls[0]!.settle(new RpcError("BAD_REQUEST", "IMAP login failed: Invalid credentials", undefined, { i18n: { key: "errors.imap.loginFailed" } }));
    expect(await pending).toBe(false);
    // the account working (another window's event) doesn't wipe what the user is looking at
    accountsChanged([account(1, false)]);
    expect(useSignIn.getState().attempts.get(1)?.error).toEqual({ message: "That password didn’t work. Check it, or create a new app password.", detail: "IMAP login failed: Invalid credentials" });
  });
});

// @vitest-environment jsdom
import type { Account, AccountSyncState } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { setApp } from "~/state/app";
import { FirstSyncPill, firstSyncing } from "./first-sync-pill";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = (id: number, sync: Partial<AccountSyncState>, window: number | null = null): Account => ({
  id, kind: "imap", email: `a${id}@example.test`, displayName: `A${id}`, color: "blue", senderName: "A", signature: "", syncWindowDays: window,
  syncState: { status: "syncing", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null, ...sync },
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => act(() => setApp({ accounts: [] })));

it("plan 79: only an account's first pass, and not while it's offline, signed out or failed", () => {
  expect(firstSyncing(account(1, {}))).toBe(true);
  expect(firstSyncing(account(1, { lastSyncAt: 5 }))).toBe(false);
  expect(firstSyncing(account(1, { status: "idle" }))).toBe(false);
  expect(firstSyncing(account(1, { status: "error" }))).toBe(false);
  expect(firstSyncing(account(1, { connection: { state: "reconnecting", retryAt: null } }))).toBe(false);
  expect(firstSyncing(account(1, { authRequired: true }))).toBe(false);
});

it("plan 79: says the account's window, the General one when it has none, and counts several", async () => {
  await act(async () => root.render(<FirstSyncPill />));
  expect(host.querySelector('[data-testid="first-sync-pill"]')).toBeNull();
  act(() => setApp({ accounts: [account(1, {}, 30), account(2, { lastSyncAt: 5 })] }));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Downloading your mail");
  expect(host.querySelector('[data-testid="first-sync-detail"]')?.textContent).toBe("The last 30 days, newest first");
  act(() => setApp({ accounts: [account(1, {})] }));
  expect(host.querySelector('[data-testid="first-sync-detail"]')?.textContent).toBe("The last 180 days, newest first");
  // in the words the dialog chose it with ("The last year", never "365 days")
  act(() => setApp({ accounts: [account(1, {}, 365)] }));
  expect(host.querySelector('[data-testid="first-sync-detail"]')?.textContent).toBe("The last year, newest first");
  act(() => setApp({ accounts: [account(1, {}, 730)] }));
  expect(host.querySelector('[data-testid="first-sync-detail"]')?.textContent).toBe("The last 2 years, newest first");
  act(() => setApp({ accounts: [account(1, {}), account(2, {})] }));
  expect(host.querySelector('[data-testid="first-sync-detail"]')?.textContent).toBe("2 accounts, newest first");
  act(() => setApp({ accounts: [account(1, { status: "idle", lastSyncAt: 9 })] }));
  expect(host.querySelector('[data-testid="first-sync-pill"]')).toBeNull();
});

import type { Account } from "@terno/core";
import { describe, expect, it } from "vitest";
import { accountLabels } from "./account-labels";

const account = (id: number, email: string, displayName: string, color = "indigo"): Account => ({
  id,
  kind: "gmail",
  email,
  displayName,
  color,
  senderName: displayName,
  signature: "",
  syncWindowDays: null,
  syncState: { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null },
});

describe("accountLabels (plan 23)", () => {
  it("names an account by its display name", () => {
    const labels = accountLabels([account(1, "luis@acme.studio", "Acme Studio"), account(2, "luis.cordero@gmail.com", "Personal")]);
    expect(labels.get(1)).toEqual({ text: "Acme Studio", email: "luis@acme.studio", color: "indigo" });
    expect(labels.get(2)!.text).toBe("Personal");
  });

  it("falls back to the address, split so the domain survives truncation, when the name is empty, the address or shared", () => {
    const labels = accountLabels([
      account(1, "luis.cordero@gmail.com", "Luis Cordero"),
      account(2, "compras.luis@gmail.com", "luis cordero"),
      account(3, "hola@luiscordero.dev", "  "),
      account(4, "l@icloud.com", "L@iCloud.com"),
    ]);
    expect(labels.get(1)).toEqual({ text: "luis.cordero@gmail.com", local: "luis.cordero", domain: "@gmail.com", email: "luis.cordero@gmail.com", color: "indigo" });
    expect(labels.get(2)).toMatchObject({ local: "compras.luis", domain: "@gmail.com" });
    expect(labels.get(3)).toMatchObject({ local: "hola", domain: "@luiscordero.dev" });
    expect(labels.get(4)).toMatchObject({ local: "l", domain: "@icloud.com" });
  });

  it("is computed once per accounts array, and keeps each unchanged label's object across new arrays (no row re-renders on sync events)", () => {
    const a = [account(1, "a@x.com", "Work", "rose"), account(2, "b@y.com", "Home", "cyan")];
    const first = accountLabels(a);
    expect(accountLabels(a)).toBe(first);
    // a sync-state event: new account objects, same labels
    const b = a.map((x) => ({ ...x, syncState: { ...x.syncState, status: "syncing" as const } }));
    const second = accountLabels(b);
    expect(second).not.toBe(first);
    expect(second.get(1)).toBe(first.get(1));
    expect(second.get(2)).toBe(first.get(2));
    // a rename changes only that label
    const third = accountLabels(b.map((x) => (x.id === 2 ? { ...x, displayName: "House" } : x)));
    expect(third.get(1)).toBe(first.get(1));
    expect(third.get(2)).not.toBe(first.get(2));
    expect(third.get(2)!.text).toBe("House");
  });
});

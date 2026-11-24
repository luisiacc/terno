import { ProviderCooldownError } from "@terno/mail/portable";
import { encodeCooldown, mailboxDigest, OAUTH_SERVICES, type CooldownRow } from "@terno/store";
import { expect, it } from "vitest";
import type { AccountStatus } from "./account-status";
import { savedAccountRequests } from "./account-requests";
import type { NetworkPolicy } from "./net-policy";
import { ProviderCooldown } from "./provider-cooldown";

it("plan 264 (Codex code review): a binding a recovery read back constrains a token refresh before the next proof adopts it", async () => {
  const stamp = { id: 1, email: "one@example.test", createdAt: 1 };
  const key = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
  // the mailbox's sign-in endpoint is paused until 3 600 000
  const row: CooldownRow = { owner: key, service: "oauth-token", revision: "2", phaseRevision: "2", minimum: "3600000", wall: "1000", replay: "3599000", sample: 2000, position: 1, hold: null, repair: null };
  let encoded: string | null = encodeCooldown({ version: 1, revision: "2", overflow: false, bindings: [{ id: 1, createdAt: 1, emailDigest: key, mailboxKey: key }], rows: [row] });
  let broken = true;
  const gate = await ProviderCooldown.open({ read: async () => { if (broken) throw new Error("Synthetic read failure"); return encoded; }, update: async (fn) => { const v = fn(encoded); encoded = v.encoded; return v.result; } }, { wallNow: () => 2000, elapsedNow: () => 10, random: () => 0.5 }, { setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimeout: () => {} });
  const status = { signInRequired: false, policyPaused: false, policyRevision: 0 } as unknown as AccountStatus;
  const net = { providerAvailable: () => true } as unknown as NetworkPolicy;
  // made while the ledger couldn't be read: the installation's scope
  const requests = await savedAccountRequests({ status, gate, net, services: OAUTH_SERVICES.gmail!, store: { read: async () => encoded, update: async () => { throw new Error("unused"); }, bind: async () => false }, stamp, live: () => true, credentials: () => 1, write: (work) => work(), changed() {} });
  broken = false;
  await gate.retry();
  expect(() => requests.check({ endpoint: "oauth-token", purpose: "refresh" })).toThrow(ProviderCooldownError);
  expect(() => requests.check({ endpoint: "gmail-api", purpose: "mail" })).not.toThrow();
  requests.close();
  await gate.close();
});

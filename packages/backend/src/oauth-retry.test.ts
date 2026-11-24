import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, type HttpResponseEvidence, type ProviderRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const forbidden: HttpResponseEvidence = { source: "http-response", request: { endpoint: "unknown", purpose: "unknown" }, status: 403, quotaScope: "unknown", received: { source: "date-now", kind: "wall", wallMs: 0 }, retryAfter: { kind: "not-visible" }, serverDate: { kind: "not-visible" } };

// Plan 259 (Codex code review of stage 0a #4): Google's 429/403 cooldown path waits for its request policy to wake the
// account; an account without one (Outlook, before its Graph provider) retries on the ordinary schedule instead.
it("a retryable 403 from an account with no request policy retries on the ordinary schedule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-oauth-retry-"));
  const providers: ProviderRegistry = {
    create: () => ({ async verify() {}, async sync() { throw new ProviderError("synthetic refusal", true, false, false, forbidden); }, async execute() {}, async close() {} }),
    async verifyImap() {}, connectGmail: async () => { throw new Error("unused"); },
  };
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers, autoSync: false });
  cleanups.push(async () => { await backend.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { account } = await backend.store.accounts.create({ kind: "outlook", email: "o@outlook.test", displayName: "O", color: "brown", providerConfig: {}, secret: { key: "refreshToken", blob: await plaintextCipher.encrypt("synthetic") }, now: 1 });
  await backend.start();
  await backend.syncAccount(account.id).catch(() => {});
  const connectivity = (backend as unknown as { connectivity: { retryAt(id: number): number | null } }).connectivity;
  expect(connectivity.retryAt(account.id)).not.toBeNull();
});

import type { AccountStatus } from "./account-status";
import { ProviderCooldownError, type AccountRequests, type HttpRequestContext, type MailAdmission, type ProviderRequests } from "@terno/mail/portable";
import { COOLDOWN_SERVICES, mailboxDigest, type CooldownService, type CooldownStamp, type OAuthServices, type ProviderCooldownStore } from "@terno/store";
import type { ProviderCooldown } from "./provider-cooldown";
import type { NetworkPolicy } from "./net-policy";

/** plan 264: after a bind that didn't settle locally, the account waits this long (or Retry Now) before binding again */
export const REBIND_MS = 30_000;

export interface SavedAccountRequests extends AccountRequests {
  readonly services: OAuthServices;
  readonly paused: boolean;
  readonly policyPaused: boolean;
  recoverPolicy(): void;
  retryAt(): number | undefined;
  close(): void;
}

export async function savedAccountRequests(input: {
  status: AccountStatus;
  gate: ProviderCooldown;
  net: NetworkPolicy;
  store: ProviderCooldownStore;
  stamp: CooldownStamp;
  /** plan 259: the account's provider's services (OAUTH_SERVICES); pauses and proofs are about its own mail API */
  services: OAuthServices;
  live(): boolean;
  credentials(): number;
  write<T>(work: () => Promise<T>): Promise<T>;
  changed(): void;
  setTimeout?(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout?(timer: ReturnType<typeof setTimeout>): void;
}): Promise<SavedAccountRequests> {
  const { gate, net } = input;
  const service = input.services.mail;
  const mail = { endpoint: service, purpose: "mail" } as const;
  const stamp = { ...input.stamp };
  const digest = await mailboxDigest(stamp.email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
  let owner = await gate.bindingFor(stamp);
  let scope = owner ? await gate.requestsForAccount(stamp, input.live) : gate.requestsFor("installation", input.live);
  const installation = gate.requestsFor("installation", input.live);
  const policies = new Set([scope, installation]);
  let paused = false, closed = false;
  // plan 264: a bind that didn't settle defers the account (no op claimed and refunded in a loop) until REBIND_MS or
  // Retry Now; the mailbox it proved stays proven for these credentials, so binding again asks Google nothing
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let proven: { key: string; epoch: number } | undefined;
  const timer = input.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = input.clearTimeout ?? ((t) => clearTimeout(t));
  const undefer = () => { if (deferred === undefined) return; clearTimer(deferred); deferred = undefined; input.changed(); };
  const defer = () => {
    if (deferred !== undefined || !alive()) return;
    deferred = timer(() => { deferred = undefined; input.changed(); }, REBIND_MS);
    input.changed();
  };
  const policyPaused = () => input.status.policyPaused;
  let proving: Promise<void> | undefined;
  const alive = () => !closed && input.live();
  const refuse = () => new ProviderCooldownError(service, "0", "binding");
  const unsettled = () => new ProviderCooldownError(service, "0", "storage");
  /** the gate's binding for this account (one a recovery read back, or a bind written but not confirmed) becomes its scope */
  const adopt = async (key: string, active: () => boolean): Promise<boolean> => {
    if (await gate.bindingFor(stamp) !== key || !active()) return false;
    const replacement = await gate.requestsForAccount(stamp, input.live);
    if (!active() || owner) { replacement.close(); return !!owner; }
    policies.add(replacement);
    // Old tickets still own their native responses; switching does not retire them.
    scope.accessAvailable();
    scope = replacement;
    owner = key;
    undefer();
    input.changed();
    return true;
  };
  const check = (request: HttpRequestContext, admission: MailAdmission = "background") => {
    if (!alive() || input.status.signInRequired || paused || (request.endpoint === service && policyPaused())) throw refuse();
    if (deferred !== undefined) throw unsettled();
    installation.check({ request });
    scope.check({ request });
    // plan 264: a binding the ledger has now (read back by a recovery after this provider was made) constrains every
    // request, a token refresh included, before the next proof adopts it as this account's scope
    const bound = owner ? null : gate.boundOwner(stamp, digest);
    if (bound && COOLDOWN_SERVICES.includes(request.endpoint as CooldownService)) {
      const state = gate.state(bound, request.endpoint as CooldownService);
      if (state.kind !== "ready") throw new ProviderCooldownError(request.endpoint, gate.revisionFor(bound, request.endpoint as CooldownService) ?? "0", state.kind === "at" ? "timed" : state.reason);
    }
    if (!net.providerAvailable(admission)) throw new ProviderCooldownError(request.endpoint, "0", "capacity");
  };
  const pause = () => { paused = true; input.changed(); };
  const constraint = (epoch: number, active: () => boolean) => input.status.constrain(
    { generation: epoch, live: active }, new ProviderCooldownError(service, "0", "quota"), () => gate.mailConstrained(owner ?? "installation", stamp, input.services),
  );
  return {
    generation: input.credentials,
    services: input.services,
    get paused() { return paused || deferred !== undefined || policyPaused(); },
    get policyPaused() { return policyPaused(); },
    recoverPolicy() { undefer(); if (input.status.recoverPolicy()) input.changed(); },
    retryAt() {
      const states = [gate.state(owner ?? "installation", service), gate.state("installation", service)];
      const dates = states.flatMap((state) => state.kind === "at" ? [state.atMs] : []);
      return dates.length ? Math.max(...dates) : undefined;
    },
    check,
    close() { closed = true; if (deferred !== undefined) clearTimer(deferred); deferred = undefined; for (const policy of policies) policy.close(); },
    tokenUnavailable: () => scope.tokenUnavailable(),
    accessAvailable: () => scope.accessAvailable(),
    request(descriptor, resource, init) {
      const epoch = descriptor.generation ?? input.credentials();
      const revision = input.status.policyRevision;
      const active = () => alive() && input.credentials() === epoch;
      const assert = () => { if (!active()) throw new ProviderCooldownError(descriptor.request.endpoint, "0", "closed"); check(descriptor.request, descriptor.admission); };
      const policy: ProviderRequests = {
        ...scope,
        check(d) { assert(); scope.check(d); },
        reserve(d) {
          assert();
          const ticket = scope.reserve(d);
          return { ...ticket, headers429: (e) => active() ? ticket.headers429(e) : Promise.resolve("unconfirmed"), dispatch: (transport) => ticket.dispatch(() => { assert(); return transport(); }) };
        },
      };
      return net.fetchProvider(policy, { ...descriptor, admission: descriptor.admission ?? "background", onForbidden: descriptor.onForbidden ? (settle) => descriptor.onForbidden!(async (kind, error) => {
        const current = active() && !init?.signal?.aborted;
        if (current && kind === "policy" && error && descriptor.request.endpoint === service) void input.status.forbid({ generation: epoch, live: active }, revision, error);
        await settle(current ? kind : "none");
        if (current && kind === "quota") void constraint(epoch, active);
      }) : undefined })(resource, init).then((response) => {
        if (response.status === 429 && active()) void constraint(epoch, active);
        return response;
      });
    },
    prove(read, admission) {
      if (!alive() || paused) throw refuse();
      if (owner) return Promise.resolve();
      check(mail, admission);
      if (proving) return proving;
      const epoch = input.credentials();
      const active = () => alive() && input.credentials() === epoch;
      proving = (async () => {
        // a binding already in the ledger (recovered, or written by a bind that wasn't confirmed) needs no proof
        const known = await gate.bindingFor(stamp);
        if (known && await adopt(known, active)) { check(mail, admission); return; }
        if (!active()) throw refuse();
        let key = proven?.epoch === epoch ? proven.key : undefined;
        if (!key) {
          const email = await read();
          if (!active()) throw refuse();
          // a grant for another mailbox: only a sign-in answers it
          if (email.trim().toLowerCase() !== stamp.email.trim().toLowerCase()) { pause(); throw refuse(); }
          key = await mailboxDigest(email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
          if (!active()) throw refuse();
          proven = { key, epoch };
        }
        const mailbox = key;
        check(mail, admission);
        // plan 264: the local steps (a writer in flight, the store, the confirming read) never latch: binds are
        // serialized by the gate, wait for a writer instead of failing beside it, and one that doesn't settle defers
        try {
          const bound = await gate.bind(async () => { check(mail, admission); return await input.write(() => input.store.bind(stamp, mailbox, active)) && active(); });
          if (!active()) throw refuse();
          // the saved account is no longer this provider's (its address or creation changed under it)
          if (bound === "refused") { pause(); throw refuse(); }
          if (bound !== "confirmed" || !await adopt(mailbox, active)) throw unsettled();
        } catch (error) {
          if (!active() || (error instanceof ProviderCooldownError && error.cooldown.kind === "binding")) throw refuse();
          if (!(error instanceof ProviderCooldownError) || error.cooldown.kind === "storage") { defer(); throw unsettled(); }
          throw error;
        }
        check(mail, admission);
      })().finally(() => { proving = undefined; });
      return proving;
    },
  };
}

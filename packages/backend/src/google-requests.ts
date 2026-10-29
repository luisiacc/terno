import { ProviderCooldownError, type GoogleRequests, type HttpRequestContext, type ProviderRequests } from "@terno/mail/portable";
import { mailboxDigest, type CooldownStamp, type ProviderCooldownStore } from "@terno/store";
import type { ProviderCooldown } from "./provider-cooldown";
import type { NetworkPolicy } from "./net-policy";

const mail = { endpoint: "gmail-api", purpose: "mail" } as const;

export interface SavedGoogleRequests extends GoogleRequests {
  readonly paused: boolean;
  close(): void;
}

export async function savedGoogleRequests(input: {
  gate: ProviderCooldown;
  net: NetworkPolicy;
  store: ProviderCooldownStore;
  stamp: CooldownStamp;
  live(): boolean;
  credentials(): number;
  write<T>(work: () => Promise<T>): Promise<T>;
  changed(): void;
}): Promise<SavedGoogleRequests> {
  const { gate, net } = input;
  const stamp = { ...input.stamp };
  let owner = await gate.bindingFor(stamp);
  let scope = owner ? await gate.requestsForAccount(stamp, input.live) : gate.requestsFor("installation", input.live);
  const installation = gate.requestsFor("installation", input.live);
  const policies = new Set([scope, installation]);
  let paused = false, closed = false;
  let proving: Promise<void> | undefined;
  const alive = () => !closed && input.live();
  const refuse = () => new ProviderCooldownError("gmail-api", "0", "binding");
  const check = (request: HttpRequestContext) => {
    if (!alive() || paused) throw refuse();
    installation.check({ request });
    scope.check({ request });
    if (net.googlePending() >= 64) throw new ProviderCooldownError(request.endpoint, "0", "capacity");
  };
  const pause = () => { paused = true; input.changed(); };
  return {
    generation: input.credentials,
    get paused() { return paused; },
    check,
    close() { closed = true; for (const policy of policies) policy.close(); },
    tokenUnavailable: () => scope.tokenUnavailable(),
    accessAvailable: () => scope.accessAvailable(),
    request(descriptor, resource, init) {
      const epoch = descriptor.generation ?? input.credentials();
      const active = () => alive() && input.credentials() === epoch;
      const assert = () => { if (!active()) throw new ProviderCooldownError(descriptor.request.endpoint, "0", "closed"); check(descriptor.request); };
      const policy: ProviderRequests = {
        ...scope,
        check(d) { assert(); scope.check(d); },
        reserve(d) {
          assert();
          const ticket = scope.reserve(d);
          return { ...ticket, dispatch: (transport) => ticket.dispatch(() => { assert(); return transport(); }) };
        },
      };
      return net.fetchGoogle(policy, descriptor)(resource, init);
    },
    prove(read) {
      if (!alive() || paused) throw refuse();
      if (owner) return Promise.resolve();
      check(mail);
      if (proving) return proving;
      const epoch = input.credentials();
      const active = () => alive() && input.credentials() === epoch;
      proving = (async () => {
        const email = await read();
        if (!active()) throw refuse();
        if (email.trim().toLowerCase() !== stamp.email.trim().toLowerCase()) { pause(); throw refuse(); }
        const key = await mailboxDigest(email, (bytes) => crypto.subtle.digest("SHA-256", bytes));
        if (!active()) throw refuse();
        // Do not interleave a bind with an unconfirmed cooldown writer.
        if (await gate.drain(5000) !== "drained" || !active()) { pause(); throw refuse(); }
        check(mail);
        try {
          if (!await input.write(() => input.store.bind(stamp, key, active)) || !active()) throw refuse();
          if (await gate.refreshAfterBind() !== "confirmed" || !active()) throw refuse();
          const bound = await gate.bindingFor(stamp);
          if (bound !== key || !active()) throw refuse();
          const replacement = await gate.requestsForAccount(stamp, input.live);
          if (!active()) { replacement.close(); throw refuse(); }
          policies.add(replacement);
          // Old tickets still own their native responses; switching does not retire them.
          scope.accessAvailable();
          scope = replacement;
          owner = key;
          input.changed();
        } catch (error) {
          pause();
          throw error instanceof ProviderCooldownError ? error : refuse();
        }
        check(mail);
      })().finally(() => { proving = undefined; });
      return proving;
    },
  };
}

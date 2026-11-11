import { ProviderAuthError, type MailProvider, type ProviderOp } from "@terno/mail/portable";

/** One refused sign-in a provider call ended with: the credential generation it ran on, and whether it was a send. */
export interface Refusal {
  error: ProviderAuthError;
  generation: number;
  send: boolean;
}

/**
 * Plan 184: the one boundary where a provider's refused sign-in reaches the account, whatever method raised it
 * (a sync, an action, a search, a body, a folder change, photos) and whatever provider kind it is. Every method's
 * rejection is looked at; a ProviderAuthError is handed to `refused` with the generation read as the call began
 * (even if `tokenResult` reported it with the token's: a refusal is idempotent, and the call's generation is what
 * its caller acts on), and the caller sees the error only once the account says so (whether or not that was saved:
 * a caller that must know awaits the report itself). Values and synchronous results pass through untouched.
 */
export function observeRefusals(provider: MailProvider, o: {
  generation(): number;
  refused(refusal: Refusal): Promise<void>;
}): MailProvider {
  const report = (error: unknown, generation: number, send: boolean): Promise<void> | undefined => {
    if (!(error instanceof ProviderAuthError)) return;
    return o.refused({ error, generation, send }).catch(() => {});
  };
  const wrapped = new Map<PropertyKey, { method: (...args: unknown[]) => unknown; through: (...args: unknown[]) => unknown }>();
  return new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const known = wrapped.get(key);
      if (known?.method === value) return known.through;
      const method = value as (...args: unknown[]) => unknown;
      const through = (...args: unknown[]): unknown => {
        const generation = o.generation();
        const send = key === "execute" && (args[0] as ProviderOp | undefined)?.kind === "send";
        let result: unknown;
        try {
          result = method.apply(target, args);
        } catch (error) {
          void report(error, generation, send);
          throw error;
        }
        if (!(result instanceof Promise)) return result;
        return result.catch(async (error: unknown) => {
          await report(error, generation, send);
          throw error;
        });
      };
      wrapped.set(key, { method, through });
      return through;
    },
  });
}

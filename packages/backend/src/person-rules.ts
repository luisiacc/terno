import { addressKey, PERSON_RULES_MAX, type PersonRule } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";

/**
 * Plan 278 ("Counts as a person", from a sender's menu): your word on who is a person, which outranks every guess but
 * Spam's in plan 17's facts (People, "to reply to", Needs you). The store keeps the rules and recomputes the sender's
 * threads in the same command; here, the errors, the exact Undo and who's told. Local: nothing reaches a model or leaves
 * the machine.
 */

export interface PersonRulesHost {
  readonly store: MailStore;
  now(): number;
  uuid(): string;
  /** the threads the store recomputed (lists, counts, What matters read them); also wakes the facts' job for a sender with more */
  threadsChanged(threadIds: readonly number[]): void;
  /** the rules moved: every window's menus and Settings */
  listChanged(rules: readonly PersonRule[]): void;
}

export class PersonRules {
  constructor(private readonly host: PersonRulesHost) {}

  list(): Promise<PersonRule[]> {
    return this.host.store.facts.rules.list();
  }

  /** A person, or not, from now on. `prior`: the rule this replaced (the Undo's); `set` null: the sender had that rule already. */
  async set(p: { email: string; name: string; person: boolean }): Promise<{ set: PersonRule | null; prior: PersonRule | null }> {
    if (!addressKey(p.email).includes("@")) throw new RpcError("BAD_REQUEST", L("errors.personRules.invalid"));
    const r = await this.host.store.facts.rules.set({ id: this.host.uuid(), email: p.email, name: p.name, person: p.person, at: this.host.now() });
    if (r === "full") throw new RpcError("BAD_REQUEST", L("errors.personRules.full", { count: PERSON_RULES_MAX }));
    if (r.set) await this.told(r.threadIds);
    return { set: r.set, prior: r.prior };
  }

  /** Back to the usual guesses. `id`: only that entry. */
  async remove(p: { email: string; id?: string }): Promise<{ removed: PersonRule | null }> {
    const r = await this.host.store.facts.rules.remove(addressKey(p.email), p.id);
    if (r.removed) await this.told(r.threadIds);
    return { removed: r.removed };
  }

  /** An Undo: `to` (or none) only while the rule is still `expect`; never one dated later than now. */
  async restore(p: { email: string; expect: string | null; to: Omit<PersonRule, "key"> | null }): Promise<{ restored: boolean }> {
    const key = addressKey(p.email);
    const to = p.to && { ...p.to, key, email: p.to.email.trim(), at: Math.min(p.to.at, this.host.now()) };
    if (to && addressKey(to.email) !== key) throw new RpcError("BAD_REQUEST", L("errors.personRules.invalid"));
    const r = await this.host.store.facts.rules.restore(key, p.expect, to);
    if (r.restored) await this.told(r.threadIds);
    return { restored: r.restored };
  }

  // every change tells, threads or none: a sender past the inline bound has its facts' job to wake (Codex review, #5)
  private async told(threadIds: readonly number[]): Promise<void> {
    this.host.threadsChanged(threadIds);
    this.host.listChanged(await this.list());
  }
}

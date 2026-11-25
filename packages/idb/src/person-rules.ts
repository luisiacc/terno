import { addressKey, PERSON_RULES_MAX, type PersonRule } from "@terno/core";
import type { PersonRuleChange, PersonRuleSet } from "@terno/store";
import { requeueSender } from "./facts";
import { T, type Ctx, type R } from "./mail";

/** Plan 278 on IndexedDB, like SQL's (packages/db/src/person-rules.ts). */

const NAME_MAX = 200;

const toRule = (r: R): PersonRule => ({ id: r.id, key: r.key, email: r.email, name: r.name, person: r.person === 1, at: r.created_at });

export const listRules = (c: Ctx): PersonRule[] => [...T(c, "person_rules").all()].map(toRule).sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

function write(c: Ctx, r: PersonRule): void {
  T(c, "person_rules").put({ key: r.key, id: r.id, email: r.email, name: r.name, person: r.person ? 1 : 0, created_at: r.at });
}

function requeued(c: Ctx, key: string): number[] {
  const touched = new Set<number>();
  requeueSender(c.db, key, touched);
  return [...touched];
}

/** As SQL's: the rule, the one it replaced (`prior`), the facts; at the cap only a sender without a rule is refused. */
export function setRule(c: Ctx, r: Omit<PersonRule, "key">): PersonRuleSet {
  const key = addressKey(r.email);
  if (!key.includes("@")) throw new TypeError("not an address");
  const rules = T(c, "person_rules");
  const was = rules.get(key);
  if (was && (was.person === 1) === r.person) return { set: null, prior: null, threadIds: [] };
  if (!was && rules.size >= PERSON_RULES_MAX) return "full";
  const rule: PersonRule = { id: r.id, key, email: r.email.trim(), name: r.name.trim().slice(0, NAME_MAX), person: r.person, at: r.at };
  write(c, rule);
  return { set: rule, prior: was ? toRule(was) : null, threadIds: requeued(c, key) };
}

/** As SQL's: only that `id`'s, when one is named. */
export function removeRule(c: Ctx, key: string, id?: string): PersonRuleChange & { removed: PersonRule | null } {
  const rules = T(c, "person_rules");
  const was = rules.get(key);
  if (!was || (id !== undefined && was.id !== id)) return { removed: null, threadIds: [] };
  rules.delete(key);
  return { removed: toRule(was), threadIds: requeued(c, key) };
}

/** As SQL's: an exact Undo, only while the rule is still `expect`. */
export function restoreRule(c: Ctx, key: string, expect: string | null, to: PersonRule | null): PersonRuleChange & { restored: boolean } {
  const rules = T(c, "person_rules");
  if (((rules.get(key)?.id as string | undefined) ?? null) !== expect) return { restored: false, threadIds: [] };
  if (to) write(c, { ...to, key, name: to.name.slice(0, NAME_MAX) });
  else rules.delete(key);
  return { restored: true, threadIds: requeued(c, key) };
}

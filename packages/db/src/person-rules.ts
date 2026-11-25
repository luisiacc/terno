import { addressKey, PERSON_RULES_MAX, type PersonRule } from "@terno/core";
import type { PersonRuleChange, PersonRuleSet } from "@terno/store";
import { requeueSender } from "./facts";
import type { Db } from "./sqlite";

/** Plan 278 on SQLite (v83): your word on who is a person, one sender at a time. See MailStore's `facts.rules`. */

const NAME_MAX = 200;

type Raw = { key: string; id: string; email: string; name: string; person: number; created_at: number };
const toRule = (r: Raw): PersonRule => ({ id: r.id, key: r.key, email: r.email, name: r.name, person: r.person === 1, at: r.created_at });

export const listRules = (db: Db): PersonRule[] => db.all<Raw>("SELECT * FROM person_rules ORDER BY created_at DESC, key").map(toRule);

const getRaw = (db: Db, key: string) => db.get<Raw>("SELECT * FROM person_rules WHERE key = ?", key);

function write(db: Db, r: PersonRule): void {
  db.run("INSERT OR REPLACE INTO person_rules (key, id, email, name, person, created_at) VALUES (?, ?, ?, ?, ?, ?)", r.key, r.id, r.email, r.name, r.person ? 1 : 0, r.at);
}

/** The sender's threads' facts again: those done here, the rest the facts' sender job's (the caller wakes it). */
function requeued(db: Db, key: string): number[] {
  const touched = new Set<number>();
  requeueSender(db, key, touched);
  return [...touched];
}

/**
 * One command: the sender's rule (the other one it replaces is `prior`, for the Undo) and their threads' facts. The same
 * rule already: nothing. At the cap, only a sender without a rule is refused.
 */
export function setRule(db: Db, r: Omit<PersonRule, "key">): PersonRuleSet {
  const key = addressKey(r.email);
  if (!key.includes("@")) throw new TypeError("not an address");
  return db.tx((): PersonRuleSet => {
    const was = getRaw(db, key);
    if (was && (was.person === 1) === r.person) return { set: null, prior: null, threadIds: [] };
    if (!was && db.get<{ n: number }>("SELECT count(*) AS n FROM person_rules")!.n >= PERSON_RULES_MAX) return "full";
    const rule: PersonRule = { id: r.id, key, email: r.email.trim(), name: r.name.trim().slice(0, NAME_MAX), person: r.person, at: r.at };
    write(db, rule);
    return { set: rule, prior: was ? toRule(was) : null, threadIds: requeued(db, key) };
  });
}

/** The rule gone (only that `id`'s, when one is named), the facts back to the guesses. */
export function removeRule(db: Db, key: string, id?: string): PersonRuleChange & { removed: PersonRule | null } {
  return db.tx(() => {
    const was = getRaw(db, key);
    if (!was || (id !== undefined && was.id !== id)) return { removed: null, threadIds: [] };
    db.run("DELETE FROM person_rules WHERE key = ?", key);
    return { removed: toRule(was), threadIds: requeued(db, key) };
  });
}

/** An exact Undo: `to` (or none) only while the sender's rule is still `expect` (an id, or none); past the cap if it must. */
export function restoreRule(db: Db, key: string, expect: string | null, to: PersonRule | null): PersonRuleChange & { restored: boolean } {
  return db.tx(() => {
    if ((getRaw(db, key)?.id ?? null) !== expect) return { restored: false, threadIds: [] };
    if (to) write(db, { ...to, key, name: to.name.slice(0, NAME_MAX) });
    else db.run("DELETE FROM person_rules WHERE key = ?", key);
    return { restored: true, threadIds: requeued(db, key) };
  });
}

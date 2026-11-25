import type { PersonRule } from "@terno/core";
import { t } from "@terno/i18n";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";

/**
 * Plan 278: "Counts as a person: Automatically / Always / Never", each said in a snack with an exact Undo. Always and Never's
 * put back the rule they replaced, or none, only while their own is still there; Automatically's puts back the rule it removed,
 * only while the sender has none (a later change from another window stays).
 */

export type PersonChoice = "auto" | "always" | "never";

const who = (s: { email: string; name: string }) => s.name.trim() || s.email;

/**
 * False: it failed (said in the snack). `id`: Automatically takes off only that entry, the one a list showed (another window
 * may have changed it since: Codex code review #3).
 */
export async function choosePerson(sender: { email: string; name: string }, choice: PersonChoice, id?: string): Promise<boolean> {
  try {
    if (choice === "auto") {
      const { removed } = await client.call("people.removeRule", { email: sender.email, ...(id !== undefined ? { id } : {}) });
      // none (another window reset it): nothing to say or undo
      if (removed) said(t("personRules.autoDone", { sender: who(sender) }), sender, () => restore(removed.email, null, removed));
      return true;
    }
    const { set, prior } = await client.call("people.setRule", { email: sender.email, name: sender.name, person: choice === "always" });
    if (set) said(t(choice === "always" ? "personRules.alwaysDone" : "personRules.neverDone", { sender: who(sender) }), sender, () => restore(set.email, set.id, prior));
    return true;
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("personRules.failed"));
    return false;
  }
}

function said(message: string, sender: { email: string; name: string }, undo: () => Promise<unknown>): void {
  snack.success(message, { action: { label: t("common.undo"), name: t("personRules.undo", { sender: who(sender) }), undo: registerUndo(() => undo().then(() => undefined)) } });
}

const restore = (email: string, expect: string | null, to: PersonRule | null) =>
  client.call("people.restoreRule", { email, expect, to: to && { id: to.id, email: to.email, name: to.name, person: to.person, at: to.at } });

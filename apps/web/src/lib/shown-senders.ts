import type { ShownSender } from "@terno/core";
import { t } from "@terno/i18n";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";

/**
 * Plan 240: "Always show in What matters" and its Stop, each said in a snack with an exact Undo: a Show's takes off that
 * entry only and puts back the sender mute it ended; a Stop's puts back the same entry in its place.
 */

const who = (s: { email: string; name: string }) => s.name.trim() || s.email;

export async function showSender(sender: { email: string; name: string }, restore?: Pick<ShownSender, "id" | "at">): Promise<boolean> {
  try {
    const { added, unmuted } = await client.call("today.showSender", { email: sender.email, name: sender.name, ...restore });
    // shown already (another window): said the same, nothing to undo
    const undo = added ? registerUndo(() => client.call("today.stopShowingSender", { email: added.email, id: added.id, ...(unmuted ? { mute: { name: unmuted.name, at: unmuted.at } } : {}) }).then(() => undefined)) : null;
    snack.success(t("shown.done", { sender: who(sender) }), undo ? { action: { label: t("common.undo"), name: t("shown.undoShow", { sender: who(sender) }), undo } } : {});
    return true;
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("shown.failed"));
    return false;
  }
}

/** False: it failed (said in the snack). */
export async function stopShowing(sender: { email: string; name: string }): Promise<boolean> {
  try {
    const { removed } = await client.call("today.stopShowingSender", { email: sender.email });
    const undo = removed ? registerUndo(() => client.call("today.showSender", { email: removed.email, name: removed.name, id: removed.id, at: removed.at }).then(() => undefined)) : null;
    snack.success(t("shown.stopped", { sender: who(sender) }), undo ? { action: { label: t("common.undo"), name: t("shown.undoStop", { sender: who(sender) }), undo } } : {});
    return true;
  } catch (error) {
    snack.error(error instanceof Error && error.message ? error.message : t("shown.failed"));
    return false;
  }
}

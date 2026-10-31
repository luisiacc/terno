import type { OpInfo } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { localized } from "~/lib/i18n";
import { snack, withdrawSnack } from "~/lib/snack";
import { client } from "~/rpc/connection";


export function sendWarningTitle(op: Pick<OpInfo, "sentCopy" | "partialRecipients" | "recipientOutcomeUnknown">) {
  if (op.recipientOutcomeUnknown) return "actions.send.recipientUnknown";
  if (op.sentCopy && op.sentCopy !== "saved" && !op.partialRecipients) return "actions.send.copyWarning";
  return "actions.send.partial";
}

const warningId = (opId: string) => `recipient-warning-${opId}`;
// Only unresolved publications are retained; retirement needs no growing tombstone history.
const pending = new Map<string, object>();

function retireWarning(opId: string): void {
  pending.delete(opId);
  withdrawSnack(warningId(opId));
}

export async function clearRecipientDetails(opId: string): Promise<void> {
  await client.call("ops.forgetRecipientReceipt", { opId });
  retireWarning(opId);
}

export function installSendWarnings(): () => void {
  const off = client.on("op", (op) => {
    if (op.kind !== "send" || op.state !== "succeeded") return;
    pending.delete(op.id);
    if (!op.lastError) { snack.success(t("actions.send.sent"), { background: true }); return; }
    const show = (id?: string) => snack.warning(t(sendWarningTitle(op)), { id, description: localized(op.lastError, op.lastErrorI18n) ?? undefined, duration: 12_000, background: true });
    if (op.lastErrorI18n?.key !== "errors.smtp.notDeliveredTo") { show(); return; }
    const token = {}, connection = client.connectionVersion;
    pending.set(op.id, token);
    // An old op event carries old text. Current receipt availability is the authority.
    void client.call("ops.recipientReceiptPart", { opId: op.id, kind: "envelope", index: 0 }).then((part) => {
      if (pending.get(op.id) === token && connection === client.connectionVersion && part !== null) show(warningId(op.id));
    }).catch(() => {}).finally(() => { if (pending.get(op.id) === token) pending.delete(op.id); });
  });
  const retired = client.on("recipientReceiptRetired", ({ opId }) => {
    pending.delete(opId);
    const connection = client.connectionVersion;
    // This event is also emitted on a failed retireSlice: don't erase valid feedback on refusal.
    void client.call("ops.recipientReceiptPart", { opId, kind: "envelope", index: 0 }).then((part) => {
      if (connection === client.connectionVersion && part === null) retireWarning(opId);
    }).catch(() => {});
  });
  const close = client.onClose(() => pending.clear());
  const attach = client.onAttach(() => pending.clear());
  return () => { off(); retired(); close(); attach(); pending.clear(); };
}

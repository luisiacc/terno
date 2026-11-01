import type { OpInfo } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { localized } from "~/lib/i18n";
import { snack, snackPublication, withdrawSnack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp } from "~/state/app";

export function sendWarningTitle(op: Pick<OpInfo, "sentCopy" | "partialRecipients" | "recipientOutcomeUnknown">) {
  if (op.recipientOutcomeUnknown) return "actions.send.recipientUnknown";
  if (op.sentCopy && op.sentCopy !== "saved" && !op.partialRecipients) return "actions.send.copyWarning";
  return "actions.send.partial";
}

const warningId = (opId: string) => `recipient-warning-${opId}`;
// Only the newest unresolved publication owns feedback; no receipt history is retained.
let pending: { opId: string; accountId: number; email?: string; kind?: string } | null = null;
let lifetime = 0;

function retireWarning(opId: string): void {
  if (pending?.opId === opId) pending = null;
  withdrawSnack(warningId(opId));
}

export async function clearRecipientDetails(opId: string): Promise<void> {
  const generation = lifetime, connection = client.connectionVersion;
  await client.call("ops.forgetRecipientReceipt", { opId });
  if (generation === lifetime && connection === client.connectionVersion) retireWarning(opId);
}

export function installSendWarnings(): () => void {
  let active = true;
  const cancel = () => { lifetime++; pending = null; };
  cancel();
  const off = client.on("op", (op) => {
    if (op.kind !== "send" || op.state !== "succeeded") return;
    pending = null;
    if (!op.lastError) { snack.success(t("actions.send.sent"), { background: true }); return; }
    const show = (id?: string) => snack.warning(t(sendWarningTitle(op)), { id, description: localized(op.lastError, op.lastErrorI18n) ?? undefined, duration: 12_000, background: true });
    if (op.lastErrorI18n?.key !== "errors.smtp.notDeliveredTo") { show(); return; }
    const account = getApp().accounts.find((entry) => entry.id === op.accountId);
    const token = { opId: op.id, accountId: op.accountId, email: account?.email, kind: account?.kind }, connection = client.connectionVersion, owner = snackPublication();
    pending = token;
    // An old op event carries old text. Current receipt availability is the authority.
    void client.call("ops.recipientReceiptPart", { opId: op.id, kind: "envelope", index: 0 }).then((part) => {
      if (active && pending === token && connection === client.connectionVersion && owner === snackPublication() && part !== null) show(warningId(op.id));
    }).catch(() => {}).finally(() => { if (pending === token) pending = null; });
  });
  const retired = client.on("recipientReceiptRetired", ({ opId }) => {
    const connection = client.connectionVersion, generation = lifetime;
    // This event is also emitted on a failed retireSlice: don't erase valid feedback on refusal.
    void client.call("ops.recipientReceiptPart", { opId, kind: "envelope", index: 0 }).then((part) => {
      if (active && generation === lifetime && connection === client.connectionVersion && part === null) retireWarning(opId);
    }).catch(() => {});
  });
  const close = client.onClose(cancel);
  const attach = client.onAttach(cancel);
  const accounts = client.on("accounts", (rows) => {
    const mine = pending;
    if (mine && !rows.some((row) => row.id === mine.accountId && (mine.email === undefined || row.email === mine.email && row.kind === mine.kind))) pending = null;
  });
  return () => { active = false; off(); retired(); close(); attach(); accounts(); cancel(); };
}

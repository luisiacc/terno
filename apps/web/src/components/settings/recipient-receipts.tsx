import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useRef, useState } from "react";
import type { ResultOf } from "@terno/core/rpc";
import { client } from "~/rpc/connection";
import { SettingsRow } from "./parts";

type Receipt = ResultOf<"ops.recipientReceipts">[number];
type Entry = { role: "to" | "cc" | "bcc"; email: string; outcome: "accepted" | "rejected" | "unknown" };

export function RecipientReceipts({ accountId }: { accountId: number }) {
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const [selected, setSelected] = useState<{ row: Receipt; entries: Entry[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [page, setPage] = useState(0), [detailPage, setDetailPage] = useState(0);
  const generation = useRef(0), mounted = useRef(false);
  const refresh = async (version: number) => { const next = await client.call("ops.recipientReceipts", { accountId }); if (generation.current === version) setRows(next); };
  useEffect(() => {
    mounted.current = true; const version = ++generation.current; void refresh(version).catch(() => { if (generation.current === version) setError(true); });
    const off = client.on("recipientReceiptRetired", ({ opId }) => { generation.current++; setBusy(false); setSelected(null); setRows((current) => current?.filter((row) => row.opId !== opId) ?? null); });
    const close = client.onClose(() => { generation.current++; setBusy(false); setSelected(null); setRows(null); setError(true); });
    const accounts = client.on("accounts", () => { generation.current++; setBusy(false); setSelected(null); });
    return () => { mounted.current = false; generation.current++; off(); close(); accounts(); };
  }, [accountId]);
  const details = async (row: Receipt) => {
    const version = ++generation.current, connection = client.connectionVersion; setBusy(true); setError(false); setSelected(null);
    try {
      const addresses: Omit<Entry, "outcome">[] = [], outcomes: Entry["outcome"][] = [];
      for (let index = 0; index < row.parts; index++) {
        const part = await client.call("ops.recipientReceiptPart", { opId: row.opId, kind: "envelope", index });
        if (generation.current !== version || connection !== client.connectionVersion) return;
        if (!part) throw new Error("Missing recipient details");
        const values: unknown = JSON.parse(part);
        if (!Array.isArray(values) || !values.every((value) => value && typeof value.email === "string" && ["to", "cc", "bcc"].includes(value.role))) throw new Error("Invalid recipient details");
        addresses.push(...values.map((value) => ({ role: value.role, email: value.email })));
      }
      for (let index = 0; index < Math.ceil(row.count / 128); index++) {
        const part = await client.call("ops.recipientReceiptPart", { opId: row.opId, kind: "outcomes", index });
        if (generation.current !== version || connection !== client.connectionVersion) return;
        if (!part) break;
        const values: unknown = JSON.parse(part);
        if (!Array.isArray(values) || !values.every((value) => ["accepted", "rejected", "unknown"].includes(value))) throw new Error("Invalid recipient outcomes");
        outcomes.push(...values);
      }
      if (addresses.length !== row.count) throw new Error("Incomplete recipient details");
      const complete = outcomes.length === addresses.length;
      setSelected({ row, entries: addresses.map((entry, index) => ({ ...entry, outcome: complete ? outcomes[index]! : "unknown" })) }); setDetailPage(0);
    } catch { if (generation.current === version) setError(true); }
    finally { if (generation.current === version) setBusy(false); }
  };
  const action = async (row: Receipt, kind: "recover" | "clear") => {
    generation.current++; setBusy(true); setError(false); setSelected(null);
    try { if (kind === "clear") await client.call("ops.forgetRecipientReceipt", { opId: row.opId }); else await client.call("ops.recoverRejectedRecipients", { opId: row.opId }); await refresh(generation.current); }
    catch { if (mounted.current) { setError(true); void refresh(generation.current).catch(() => {}); } }
    finally { if (mounted.current) setBusy(false); }
  };
  const current = Math.min(page, Math.max(0, Math.ceil((rows?.length ?? 0) / 25) - 1));
  const detailCurrent = Math.min(detailPage, Math.max(0, Math.ceil((selected?.entries.length ?? 0) / 25) - 1));
  return <SettingsRow label={t("account.recipientReceipts")} hint={t("account.recipientReceipts.hint")} stacked>{() => <div className="flex flex-col gap-2 pb-2 text-xs" data-testid="recipient-recovery">
    {error && <p role="alert" className="text-destructive-ink">{t("account.recipientReceipts.error")}</p>}
    {!rows && !error && <p role="status">{t("account.recipientReceipts.loading")}</p>}
    {rows?.length === 0 && <p>{t("account.recipientReceipts.empty")}</p>}
    {rows?.slice(current * 25, (current + 1) * 25).map((row) => <div key={row.opId} role="group" aria-label={new Date(row.createdAt).toLocaleString()} className="flex flex-wrap items-center justify-between gap-2" data-testid="recipient-receipt-row">
      <span>{new Date(row.createdAt).toLocaleString()}{row.outcomeUncertain ? ` · ${t("account.recipientReceipts.uncertain")}` : row.state === "pending" ? ` · ${t("account.recipientReceipts.pending")}` : ""}</span>
      <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy || row.retired} onClick={() => void details(row)}>{t("account.recipientReceipts.details")}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(row, "clear")}>{t("account.recipientReceipts.clear")}</Button></div>
    </div>)}
    {rows && rows.length > 25 && <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>{t("account.recipientReceipts.previous")}</Button><Button variant="ghost" size="sm" disabled={(current + 1) * 25 >= rows.length} onClick={() => setPage(current + 1)}>{t("account.recipientReceipts.next")}</Button></div>}
    {selected && <div className="flex flex-col gap-2"><ul>{selected.entries.slice(detailCurrent * 25, (detailCurrent + 1) * 25).map((entry, index) => <li key={`${detailCurrent}:${index}`} className="break-all">{entry.role.toUpperCase()} · {entry.email} · {t(`account.recipientReceipts.${entry.outcome}`)}</li>)}</ul>
      {selected.entries.length > 25 && <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={detailCurrent === 0} onClick={() => setDetailPage(detailCurrent - 1)}>{t("account.recipientReceipts.previous")}</Button><Button variant="ghost" size="sm" disabled={(detailCurrent + 1) * 25 >= selected.entries.length} onClick={() => setDetailPage(detailCurrent + 1)}>{t("account.recipientReceipts.next")}</Button></div>}
      {selected.row.childOpId ? <p>{t("account.recipientReceipts.claimed")}</p> : selected.entries.some((entry) => entry.outcome === "rejected") && (selected.row.sourceAvailable ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(selected.row, "recover")}>{t("account.recipientReceipts.recover")}</Button> : <p>{t("account.recipientReceipts.unavailable")}</p>)}
    </div>}
  </div>}</SettingsRow>;
}

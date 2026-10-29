import type { SentCopyInfo } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useRef, useState } from "react";
import { client } from "~/rpc/connection";
import { SettingsRow } from "./parts";

/** Mounted only for an expanded IMAP account; requests follow explicit actions. */
export function SentCopies({ accountId }: { accountId: number }) {
  const [rows, setRows] = useState<SentCopyInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const mounted = useRef(true);
  const currentPage = Math.min(page, Math.max(0, Math.ceil((rows?.length ?? 0) / 25) - 1));
  useEffect(() => {
    let current = true; mounted.current = true;
    void client.call("ops.sentCopies", { accountId }).then((value) => { if (current) setRows(value); }, () => { if (current) setError(true); });
    return () => { current = false; mounted.current = false; };
  }, [accountId]);
  const run = async (row: SentCopyInfo, action: "repair" | "forget") => {
    setBusy(row.opId); setError(false);
    try {
      if (action === "repair") { const result = await client.call("ops.repairSentCopy", { opId: row.opId }); if (result.copy !== "saved") setError(true); }
      else await client.call("ops.forgetSentCopy", { opId: row.opId });
      if (mounted.current) { const next = await client.call("ops.sentCopies", { accountId }); if (mounted.current) setRows(next); }
    } catch { setError(true); }
    finally { setBusy(null); }
  };
  return <SettingsRow label={t("account.sentCopies")} stacked hint={t("account.sentCopies.hint")}>
    {() => <div className="flex flex-col gap-2 pb-2" data-testid="sent-copy-recovery">
      {error && <p role="alert" className="text-xs text-destructive-ink">{t("errors.sentCopy.unavailable")}</p>}
      {!rows && !error && <p role="status" className="text-xs text-muted-foreground">{t("account.sentCopies.loading")}</p>}
      {rows?.length === 0 && <p className="text-xs text-muted-foreground">{t("account.sentCopies.empty")}</p>}
      {rows?.slice(currentPage * 25, (currentPage + 1) * 25).map((row) => <div key={row.opId} role="group" aria-label={new Date(row.createdAt).toLocaleString()} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="sent-copy-row">
        <span>{new Date(row.createdAt).toLocaleString()} · {t(`account.sentCopies.${row.retiring ? "retiring" : row.submission === "pending" ? "pending" : row.copy === "pending" ? "notAttempted" : row.copy}`)}</span>
        <div className="flex shrink-0 gap-1">
          {!row.retiring && row.submission === "accepted" && row.copy !== "saved" && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(row, "repair")}>{t("account.sentCopies.repair")}</Button>}
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run(row, "forget")}>{t("account.sentCopies.clear")}</Button>
        </div>
      </div>)}
      {rows && rows.length > 25 && <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("account.sentCopies.previous")}</Button>
        <Button variant="ghost" size="sm" disabled={(currentPage + 1) * 25 >= rows.length} onClick={() => setPage(currentPage + 1)}>{t("account.sentCopies.next")}</Button>
      </div>}
    </div>}
  </SettingsRow>;
}

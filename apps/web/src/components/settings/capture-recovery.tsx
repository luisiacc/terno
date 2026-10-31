import type { CaptureRepair } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { useEffect, useId, useRef, useState } from "react";
import { client } from "~/rpc/connection";

/** No requests until opened; subsequent reads follow explicit actions only. */
export default function CaptureRecovery({ accountId }: { accountId: number }) {
  const id = useId(), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [accountId]);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<(CaptureRepair & { complete?: boolean })[]>([]);
  const [next, setNext] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = async (cursor?: string) => {
    const request = ++generation.current; setBusy(true); setError(false);
    try {
      const page = await client.call("captureRepairs.list", { accountId, after: cursor });
      if (request !== generation.current) return;
      setRows(page.items); setNext(page.next);
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const retry = async (row: CaptureRepair) => {
    const request = ++generation.current; setBusy(true); setError(false);
    try {
      const { repair } = await client.call("captureRepairs.retry", { accountId, key: row.key, revision: row.revision });
      if (request !== generation.current) return;
      // Keep the completed row's control in place so retry preserves keyboard focus and scroll.
      const current = repair;
      setRows((old) => old.map((r) => r.key === row.key ? current ?? { ...r, complete: true } : r));
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <div className="hairline-t py-3" data-testid="capture-recovery">
    <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen(!open); if (!open) void load(); else generation.current++;
    }}>{t("capture.title")}</Button>
    {open && <div id={id} className="flex flex-col gap-3 pt-2" aria-busy={busy}>
      <p className="text-xs text-muted-foreground">{t("capture.hint")}</p>
      {error && <p role="alert" className="text-xs text-destructive-ink">{t("capture.error")}</p>}
      {busy && <p role="status" className="text-xs text-muted-foreground">{t("capture.loading")}</p>}
      {!busy && rows.length === 0 && <p className="text-xs text-muted-foreground">{t("capture.empty")}</p>}
      {rows.map((row, index) => <div key={row.key} role="group" aria-label={t("capture.item", { number: index + 1 })} className="flex items-center justify-between gap-3 text-xs">
        <div><p>{t("capture.item", { number: index + 1 })}</p><p className="text-muted-foreground">{row.complete ? t("capture.complete") : row.state === "pending" ? t("capture.pending") : t(row.reason === "mime-parts" ? "capture.parts" : "capture.depth")}</p></div>
        <Button variant="ghost" size="sm" focusableWhenDisabled disabled={busy || row.complete || row.state === "pending"} onClick={() => void retry(row)}>{t("capture.retry")}</Button>
      </div>)}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>{t("capture.refresh")}</Button>
        {next && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load(next)}>{t("capture.next")}</Button>}
      </div>
    </div>}
  </div>;
}

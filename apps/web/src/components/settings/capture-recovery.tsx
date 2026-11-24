import type { CaptureRepair } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { useEffect, useId, useRef, useState } from "react";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";

/** plan 267: each reason's line; one this build doesn't know (a newer build wrote it) gets the generic one */
const REASON_COPY = {
  "mime-parts": "capture.parts", "mime-depth": "capture.depth", "mime-headers": "capture.headers",
  "mime-addresses": "capture.addresses", unknown: "capture.unknown",
} as const satisfies Record<CaptureRepair["reason"], string>;

/** No requests until opened; subsequent reads follow explicit actions only. */
export default function CaptureRecovery({ accountId }: { accountId: number }) {
  const id = useId(), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [accountId]);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<(CaptureRepair & { complete?: boolean })[]>([]);
  const [after, setAfter] = useState<string>();
  const [next, setNext] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = async (cursor?: string) => {
    const request = ++generation.current; setBusy(true); setError(false);
    try {
      const page = await client.call("captureRepairs.list", { accountId, after: cursor });
      if (request !== generation.current) return;
      setRows(page.items); setAfter(cursor); setNext(page.next);
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
  // kept mounted (empty while closed): the region the trigger controls is there, hidden, before it first opens
  return <Collapsible open={open} onOpenChange={(next) => {
    setOpen(next); if (next) void load(); else generation.current++;
  }} className="hairline-t py-3" data-testid="capture-recovery">
    <CollapsibleTrigger aria-controls={id} className="rounded-md py-1 text-sm font-medium">{t("capture.title")}</CollapsibleTrigger>
    <CollapsiblePanel keepMounted id={id} className="flex flex-col gap-3 pt-2" aria-busy={open && busy}>
      {open && <>
      <p className="text-xs text-muted-foreground">{t("capture.hint")}</p>
      {error && <p role="alert" className="text-xs text-destructive-ink">{t("capture.error")}</p>}
      {busy && <p role="status" className="text-xs text-muted-foreground">{t("capture.loading")}</p>}
      {!busy && rows.length === 0 && <p className="text-xs text-muted-foreground">{t("capture.empty")}</p>}
      {rows.map((row, index) => <div key={row.key} role="group" aria-label={row.detail ? row.detail.subject ?? t("capture.noSubject") : t("capture.item", { number: index + 1 })} className="flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0">
          {/* plan 267: which message, when Terno knows (Gmail's own parse of its headers, or the stored envelope) */}
          <p className="truncate">{row.detail ? row.detail.subject ?? t("capture.noSubject") : t("capture.item", { number: index + 1 })}</p>
          {row.detail && (row.detail.from || row.detail.date) && <p className="truncate text-muted-foreground">{[row.detail.from, row.detail.date && listDate(row.detail.date)].filter(Boolean).join(" · ")}</p>}
          <p className="text-muted-foreground">{row.complete ? t("capture.complete") : row.state === "pending" ? t("capture.pending") : t(REASON_COPY[row.reason] ?? "capture.unknown")}</p>
        </div>
        <Button variant="ghost" size="sm" focusableWhenDisabled disabled={busy || row.complete || row.state === "pending"} onClick={() => void retry(row)}>{t("capture.retry")}</Button>
      </div>)}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" focusableWhenDisabled disabled={busy} onClick={() => void load()}>{t("capture.refresh")}</Button>
        {(next || after) && <Button variant="ghost" size="sm" focusableWhenDisabled disabled={busy || !next} onClick={() => void load(next)}>{t("capture.next")}</Button>}
      </div>
      </>}
    </CollapsiblePanel>
  </Collapsible>;
}

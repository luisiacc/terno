import type { DigestItem, DigestRow } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { CheckboxMark } from "@terno/ui/components/checkbox";
import { Spinner } from "@terno/ui/components/spinner";
import { useEffect, useMemo, useState } from "react";
import { errorHelp, modelName } from "~/lib/ai";
import { trackJob, undoAction, undoActions } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { useToday } from "~/state/today";

const dayLong = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(y!, m! - 1, d!));
};

/**
 * Plan 145 §4: the digest in the reader's column. Plain text, never links: a line is a model's rewording of mail. With the
 * digest off nothing has said what these are, so they're automated mail, unticked (revision 3).
 */
export default function DigestPage() {
  const digest = useToday((s) => s.digest);
  const [row, setRow] = useState<DigestRow | null>(digest);
  const ai = useApp((s) => s.settings?.ai);
  const [liveIds, setLive] = useState<ReadonlySet<number> | null>(null);
  useEffect(() => {
    let current = true;
    const read = () => void client.call("today.digest", {}).then((r) => current && setRow(r), () => {});
    read();
    const off = client.on("todayDigest", read);
    return () => {
      current = false;
      off();
    };
  }, []);
  const items = useMemo(() => row?.items ?? [], [row]);
  const automated = row?.automated === true;
  const [toggled, setToggled] = useState<ReadonlySet<number>>(new Set());
  const ticked = (i: DigestItem) => (automated ? toggled.has(i.threadId) : !toggled.has(i.threadId));
  // what's already archived or read elsewhere stays listed, muted, and out of the count, so the page doesn't reshuffle
  useEffect(() => {
    if (row) setLive(new Set(row.liveIds));
  }, [row]);
  const live = (i: DigestItem) => liveIds === null || liveIds.has(i.threadId);
  const chosen = items.filter((i) => live(i) && ticked(i));
  const toggle = (id: number) =>
    setToggled((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = (threadId: number) => {
    useToday.setState({ fromDigest: true });
    setApp({ selectedId: threadId });
  };
  const archive = async () => {
    if (!row || !chosen.length) return;
    const job = trackJob(t("today.digest.archiving"));
    const undoId = { current: null as number | null, n: 0 };
    const undo = registerUndo(() => (undoId.current === null ? undefined : undoActions([undoId.current], undoId.n)));
    try {
      const r = await client.call("today.digestArchive", { day: row.day, threadIds: chosen.map((i) => i.threadId), jobId: job.jobId });
      undoId.current = r.undoId;
      undoId.n = r.archived;
      const notes = r.changed + r.spared > 0 ? t("today.digest.leftAlone", { count: r.changed + r.spared }) : undefined;
      snack.success(t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: r.archived }), { id: job.snackId, duration: 8000, description: notes, action: r.undoId !== null ? undoAction(undo, t("today.digest.undoName")) : undefined });
      setLive((held) => new Set([...(held ?? items.map((i) => i.threadId))].filter((id) => !chosen.some((i) => i.threadId === id))));
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error), { id: job.snackId });
    } finally {
      job.stop();
      void reloadList({ keepSelection: true });
    }
  };
  if (!row) return <div className="p-8 text-sm text-muted-foreground" data-testid="digest-page">{t("today.digest.none")}</div>;
  return (
    <section data-testid="digest-page" aria-label={t("today.digest.title")} className="mx-auto w-full max-w-(--reader-max,48rem) space-y-3 overflow-y-auto px-8 pt-16 pb-8">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight" data-testid="digest-title">{t(automated ? "today.digest.automatedTitle" : "today.digest.title")}</h1>
          <span className="shrink-0 text-xs text-muted-foreground">{dayLong(row.day)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" data-testid="digest-count">{t(automated ? "today.digest.automatedCount" : "today.digest.count", { count: items.filter(live).length })}</p>
          <Button size="sm" data-testid="digest-archive" disabled={!chosen.length} onClick={() => void archive()}>{automated ? t("today.digest.archiveSelected", { count: chosen.length }) : t("today.digest.archiveAll", { count: chosen.length })}</Button>
        </div>
      </header>
      {row.state === "pending" && <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="digest-preparing"><Spinner className="size-3" /> {t("today.digest.preparing")}</p>}
      {row.state === "failed" && (
        <div className="space-y-1.5" data-testid="digest-failed">
          <p className="text-sm text-destructive-ink">{t("today.digest.failed")}</p>
          {ai && row.errorKind ? <p className="text-xs text-muted-foreground">{errorHelp(row.errorKind as Parameters<typeof errorHelp>[0], ai)}</p> : null}
          <Button size="sm" variant="secondary" data-testid="digest-retry" onClick={() => void client.call("today.digestRetry", {}).catch(() => {})}>{t("ask.tryAgain")}</Button>
        </div>
      )}
      {automated && (
        <p className="text-xs text-muted-foreground" data-testid="digest-off">
          {t("today.digest.offHint")}{" "}
          <Button variant="link-secondary" size="xs" data-testid="digest-turn-on" onClick={() => void setApp({ dialog: "settings", settingsTab: "ai" })}>{t("today.digest.offLink")}</Button>
        </p>
      )}
      <ul className="border-t border-hairline">
        {items.map((i) => (
          <li key={i.threadId} data-testid="digest-item" data-live={live(i)} className={`flex items-baseline gap-3 border-b border-hairline py-2 ${live(i) ? "" : "opacity-50"}`}>
            <CheckboxMark data-testid="digest-tick" checked={live(i) && ticked(i)} className="translate-y-0.5" onClick={() => live(i) && toggle(i.threadId)} />
            <button type="button" className="flex min-w-0 flex-1 items-baseline gap-3 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="digest-open" onClick={() => open(i.threadId)}>
              <span className="w-36 shrink-0 truncate text-sm font-medium">{i.from}</span>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">{i.line ?? i.subject}</span>
            </button>
          </li>
        ))}
      </ul>
      {!automated && row.model && <p className="text-xs text-muted-foreground" data-testid="digest-provenance">{t("today.digest.writtenBy", { model: modelName(row.model) })}</p>}
    </section>
  );
}


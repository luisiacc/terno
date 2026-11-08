import type { DigestItem, DigestRow } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronRight } from "@terno/ui/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorHelp, modelName } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { deferred, trackJob, undoAction, undoActions } from "~/lib/actions";
import { registerUndo, snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { digestPick, keepDigestPick, useToday } from "~/state/today";

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
  // plan 161: what was unticked, and where the page was, outlive it: opening a newsletter and coming back finds them.
  // Kept by digest: its day and what kind it is (a set means the unticked in one, the ticked in automated mail)
  const day = row ? `${row.day}|${automated ? "automated" : "digest"}` : "";
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => digestPick(day).toggled);
  const scroller = useRef<HTMLElement>(null);
  const scrollAt = useRef(digestPick(day).scroll);
  // back where it was left, once its rows are there: once a digest
  const restored = useRef<string | null>(null);
  const [pickOf, setPickOf] = useState(day);
  if (pickOf !== day) {
    setPickOf(day);
    setToggled(digestPick(day).toggled);
  }
  useLayoutEffect(() => {
    if (restored.current === day || !scroller.current || !row?.items.length) return;
    restored.current = day;
    scrollAt.current = digestPick(day).scroll;
    scroller.current.scrollTop = scrollAt.current;
  }, [row, day]);
  useEffect(() => {
    if (day && restored.current === day) keepDigestPick({ day, toggled, scroll: scrollAt.current });
  }, [day, toggled]);
  const ticked = (i: DigestItem) => (automated ? toggled.has(i.threadId) : !toggled.has(i.threadId));
  // the list's refresh brings what changed anywhere: an Undo, a read in another window
  useEffect(() => {
    if (digest) setRow(digest);
  }, [digest]);
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
    if (day && restored.current === day) keepDigestPick({ day, toggled, scroll: scroller.current?.scrollTop ?? 0 });
    useToday.setState({ fromDigest: threadId });
    setApp({ selectedId: threadId });
  };
  const archive = async () => {
    if (!row || !chosen.length) return;
    const job = trackJob(t("today.digest.archiving"));
    // pressed before the answer is in, it waits for it
    const undoId = deferred<{ id: number | null; n: number }>();
    const undo = registerUndo(() => undoId.promise.then((u) => (u.id === null ? undefined : undoActions([u.id], u.n))));
    try {
      const r = await client.call("today.digestArchive", { items: chosen.map((i) => ({ threadId: i.threadId, lastDate: i.lastDate, messageCount: i.messageCount })), jobId: job.jobId });
      undoId.resolve({ id: r.undoId, n: r.archived });
      const notes = r.changed + r.spared > 0 ? t("today.digest.leftAlone", { count: r.changed + r.spared }) : undefined;
      snack.success(t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: r.archived }), { id: job.snackId, duration: 8000, description: notes, action: r.undoId !== null ? undoAction(undo, t("today.digest.undoName")) : undefined });
      setLive((held) => new Set([...(held ?? items.map((i) => i.threadId))].filter((id) => !chosen.some((i) => i.threadId === id))));
    } catch (error) {
      undoId.resolve({ id: null, n: 0 });
      snack.error(error instanceof Error ? error.message : String(error), { id: job.snackId });
    } finally {
      job.stop();
      void reloadList({ keepSelection: true });
    }
  };
  if (!row) return <div className="p-8 text-sm text-muted-foreground" data-testid="digest-page">{t("today.digest.none")}</div>;
  const liveCount = items.filter(live).length;
  // plan 161: the button says what it does: all of them, or the ones still ticked
  const partial = chosen.length < liveCount;
  return (
    <section
      ref={scroller}
      data-testid="digest-page"
      aria-label={t("today.digest.title")}
      className="mx-auto w-full max-w-(--reader-max,48rem) space-y-3 overflow-y-auto px-8 pt-16 pb-8"
      onScroll={(e) => {
        if (restored.current !== day) return;
        scrollAt.current = e.currentTarget.scrollTop;
        keepDigestPick({ day, toggled, scroll: scrollAt.current });
      }}
    >
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight" data-testid="digest-title">{t(automated ? "today.digest.automatedTitle" : "today.digest.title")}</h1>
          <span className="shrink-0 text-xs text-muted-foreground">{dayLong(row.day)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground" data-testid="digest-count">
            {partial && !automated ? t("today.digest.countSelected", { count: liveCount, selected: chosen.length }) : t(automated ? "today.digest.automatedCount" : "today.digest.count", { count: liveCount })}
            {!automated && liveCount > 0 && <span className="block" data-testid="digest-tick-hint">{t("today.digest.tickHint")}</span>}
          </p>
          <Button size="sm" data-testid="digest-archive" disabled={!chosen.length} onClick={() => void archive()}>{automated || partial ? t("today.digest.archiveSelected", { count: chosen.length }) : t("today.digest.archiveAll", { count: chosen.length })}</Button>
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
          <li key={i.threadId} data-testid="digest-item" data-live={live(i)} className="flex items-start gap-2 border-b border-hairline py-1">
            <Checkbox data-testid="digest-tick" aria-label={t("today.digest.tick", { subject: i.subject })} checked={live(i) && ticked(i)} disabled={!live(i)} className="mt-2.5" onCheckedChange={() => toggle(i.threadId)} />
            {/* plan 161: reading is as plain as archiving: the whole row opens the newsletter, and says so on hover */}
            <button type="button" className="group/open -mr-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="digest-open" aria-label={t("today.digest.open", { from: i.from, subject: i.subject })} onClick={() => open(i.threadId)}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-xs">
                  <span className={`max-w-[60%] shrink-0 font-medium ${live(i) ? "text-foreground" : "text-muted-foreground"}`} data-testid="digest-from">{i.from}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="digest-subject">{i.subject}</span>
                  <span className="shrink-0 text-muted-foreground tabular">{listDate(i.lastDate)}</span>
                </span>
                {i.line !== null && <span className={`mt-0.5 block text-sm ${live(i) ? "text-foreground" : "text-muted-foreground"}`} data-testid="digest-line">{i.line}</span>}
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/open:opacity-100 group-focus-reveal/open:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
      {!automated && row.model && <p className="text-xs text-muted-foreground" data-testid="digest-provenance">{t("today.digest.writtenBy", { model: modelName(row.model) })}</p>}
    </section>
  );
}

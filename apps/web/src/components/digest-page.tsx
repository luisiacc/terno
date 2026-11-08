import type { DigestItem, DigestRow } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronRight } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorHelp, modelName } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { deferred, trackJob, undoAction, undoActions } from "~/lib/actions";
import { registerUndo, snack, undoNow } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { digestPick, keepDigestPick, useToday } from "~/state/today";
import { AiProvenance } from "~/components/ai-provenance";

const dayLong = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(y!, m! - 1, d!));
};

/**
 * Plan 161, pass 2: what each row is, said on it. To archive (ticked), kept (unticked), opened (read: plan 145 archives
 * only unread mail, so it stays), or archived (out of the Inbox).
 */
export type DigestRowState = "archive" | "keep" | "opened" | "archived";

const STATE_LABEL: Partial<Record<DigestRowState, () => string>> = { keep: () => t("today.digest.state.kept"), opened: () => t("today.digest.state.opened"), archived: () => t("today.digest.state.archived") };

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
  // pass 2: what this page archived (its rows leave, the header says it's done), held with the rest of the pick
  const batches = useToday((s) => (s.pick?.day === day ? (s.pick.done ?? null) : null));
  const scroller = useRef<HTMLDivElement>(null);
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
    const pick = digestPick(day);
    scrollAt.current = pick.scroll;
    scroller.current.scrollTop = scrollAt.current;
    // pass 2: back from a newsletter, the row it was opened from has the focus again (a program's focus: no ring)
    if (pick.opened != null) {
      scroller.current.querySelector<HTMLElement>(`[data-digest-open="${pick.opened}"]`)?.focus({ preventScroll: true });
      keepDigestPick({ day, toggled: pick.toggled, scroll: pick.scroll, opened: null });
    }
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
  const readIds = useMemo(() => new Set(row?.readIds ?? []), [row]);
  const live = (i: DigestItem) => liveIds === null || liveIds.has(i.threadId);
  const stateOf = (i: DigestItem): DigestRowState => (live(i) ? (ticked(i) ? "archive" : "keep") : readIds.has(i.threadId) ? "opened" : "archived");
  // pass 2: what this page archived leaves it; what was archived elsewhere stays, muted and said so (plan 145)
  const archivedHere = new Set((batches ?? []).flatMap((b) => b.ids));
  const shown = items.filter((i) => !(archivedHere.has(i.threadId) && stateOf(i) === "archived"));
  const chosen = items.filter((i) => stateOf(i) === "archive");
  const staying = shown.filter((i) => stateOf(i) === "keep" || stateOf(i) === "opened").length;
  const toggle = (id: number) =>
    setToggled((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = (threadId: number) => {
    if (day && restored.current === day) keepDigestPick({ day, toggled, scroll: scroller.current?.scrollTop ?? 0, opened: threadId });
    useToday.setState({ fromDigest: threadId });
    setApp({ selectedId: threadId });
  };
  const archive = async () => {
    if (!row || !chosen.length) return;
    const job = trackJob(t("today.digest.archiving"));
    const pickDay = day;
    // pressed before the answer is in, it waits for it; run here or from the snack, it ends the finished state
    const undoId = deferred<{ id: number | null; n: number }>();
    const undo = registerUndo(() =>
      undoId.promise.then(async (u) => {
        if (u.id === null) return;
        await undoActions([u.id], u.n);
        // only this Archive's rows come back (Codex review): an earlier one stays done. And only on its own day's page: a
        // later day's (or automated mail's) choices aren't this one's to touch
        const pick = useToday.getState().pick;
        if (pick?.day === pickDay) keepDigestPick({ ...pick, done: (pick.done ?? []).filter((b) => b.undo !== undo) });
      }),
    );
    try {
      const r = await client.call("today.digestArchive", { items: chosen.map((i) => ({ threadId: i.threadId, lastDate: i.lastDate, messageCount: i.messageCount })), jobId: job.jobId });
      undoId.resolve({ id: r.undoId, n: r.archived });
      const notes = r.changed + r.spared > 0 ? t("today.digest.leftAlone", { count: r.changed + r.spared }) : undefined;
      snack.success(t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: r.archived }), { id: job.snackId, duration: 8000, description: notes, action: r.undoId !== null ? undoAction(undo, t("today.digest.undoName")) : undefined });
      setLive((held) => new Set([...(held ?? items.map((i) => i.threadId))].filter((id) => !chosen.some((i) => i.threadId === id))));
      // what the backend really archived: one archived or changed elsewhere meanwhile stays listed, said so (Codex review)
      const pick = useToday.getState().pick;
      if (r.archivedIds.length && pick?.day === pickDay) keepDigestPick({ ...pick, done: [...(pick.done ?? []), { ids: r.archivedIds, undo: r.undoId !== null ? undo : null }] });
    } catch (error) {
      undoId.resolve({ id: null, n: 0 });
      snack.error(error instanceof Error ? error.message : String(error), { id: job.snackId });
    } finally {
      job.stop();
      void reloadList({ keepSelection: true });
    }
  };
  if (!row) return <div className="p-8 text-sm text-muted-foreground" data-testid="digest-page">{t("today.digest.none")}</div>;
  const done = batches?.length ? { count: batches.reduce((n, b) => n + b.ids.length, 0), undo: batches.at(-1)!.undo } : null;
  const finished = done !== null;
  return (
    // ai-r03: the pane scrolls, bounded to the reader's height, and the page is a column in it. The page itself scrolled
    // with no height to scroll in, so it grew past the window and the parent clipped its last rows (every style, since
    // plan 145); the wheel works anywhere over the pane, and the scrollbar sits at its edge
    <div
      ref={scroller}
      className="h-full min-h-0 overflow-y-auto"
      data-testid="digest-scroller"
      onScroll={(e) => {
        if (restored.current !== day) return;
        scrollAt.current = e.currentTarget.scrollTop;
        keepDigestPick({ day, toggled, scroll: scrollAt.current });
      }}
    >
    <section
      data-testid="digest-page"
      data-finished={finished || undefined}
      aria-label={t("today.digest.title")}
      className="mx-auto w-full max-w-(--reader-max,48rem) space-y-3 px-8 pt-16 pb-8"
    >
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight" data-testid="digest-title">{t(automated ? "today.digest.automatedTitle" : "today.digest.title")}</h1>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {/* pass 3: who wrote the lines, at the top as every AI result says it (it was under the list), with the one
                "Written with AI ▾" every AI surface has; the model and its caution behind it */}
            {!automated && row.model && (
              <>
                <AiProvenance model={row.model} at={0} detail={t("today.digest.writtenBy", { model: modelName(row.model) })} testId="digest-provenance" />
                <span aria-hidden>·</span>
              </>
            )}
            {dayLong(row.day)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          {finished ? (
            // pass 2: done, said as done, with its Undo here (the snack's runs the same one)
            <p role="status" className="text-sm" data-testid="digest-done">
              {t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: done.count })}.
              {shown.every((i) => stateOf(i) === "archived") && <span className="ml-1 text-muted-foreground" data-testid="digest-all-done">{t("today.digest.allDone")}</span>}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="digest-count">
              {automated ? (
                chosen.length < shown.filter(live).length ? t("today.digest.countSelected", { count: shown.filter(live).length, selected: chosen.length }) : t("today.digest.automatedCount", { count: shown.filter(live).length })
              ) : (
                <>
                  {/* pass 2: what Archive will do, in words: how many go, and how many stay */}
                  <span className="font-medium text-foreground" data-testid="digest-to-archive">{t("today.digest.toArchive", { count: chosen.length })}</span>
                  {staying > 0 && <span data-testid="digest-staying"> · {t("today.digest.staying", { count: staying })}</span>}
                </>
              )}
              {!automated && chosen.length > 0 && <span className="block" data-testid="digest-tick-hint">{t("today.digest.tickHint")}</span>}
            </p>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {finished && done.undo && (
              <Button size="sm" variant="secondary" data-testid="digest-undo" aria-label={t("today.digest.undoName")} onClick={() => undoNow(done.undo!)}>
                {t("common.undo")}
              </Button>
            )}
            {(!finished || chosen.length > 0) && (
              // the count is what goes, always: what was opened or unticked isn't in it, and its row says so
              <Button size="sm" data-testid="digest-archive" disabled={!chosen.length} onClick={() => void archive()}>
                {automated ? t("today.digest.archiveSelected", { count: chosen.length }) : t("today.digest.archiveAll", { count: chosen.length })}
              </Button>
            )}
          </div>
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
      {finished && shown.length > 0 && <h2 className="pt-2 text-xs font-medium text-muted-foreground" data-testid="digest-still-here">{t("today.digest.stillHere")}</h2>}
      {shown.length > 0 && (
        <ul className="border-t border-hairline">
          {shown.map((i) => {
            const state = stateOf(i);
            const label = automated && state === "keep" ? undefined : STATE_LABEL[state];
            const quiet = state === "opened" || state === "archived";
            return (
              <li key={i.threadId} data-testid="digest-item" data-live={live(i)} data-state={state} className="flex items-start gap-1 border-b border-hairline py-1">
                {/* pass 2: a 24 px box of its own, so a near miss doesn't open the newsletter beside it */}
                <Checkbox target="quiet" data-testid="digest-tick" aria-label={t("today.digest.tick", { subject: i.subject })} checked={state === "archive"} disabled={!live(i)} className="mt-1.5" onCheckedChange={() => toggle(i.threadId)} />
                {/* plan 161: reading is as plain as archiving: the whole row opens the newsletter, and says so on hover */}
                <button type="button" data-digest-open={i.threadId} className="group/open -mr-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-testid="digest-open" onClick={() => open(i.threadId)}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2 text-xs">
                      <span className={cn("max-w-[60%] shrink-0 font-medium", quiet ? "text-muted-foreground" : "text-foreground")} data-testid="digest-from">{i.from}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="digest-subject">{i.subject}</span>
                      {label && <span className="shrink-0 font-medium text-muted-foreground" data-testid="digest-state">{label()}</span>}
                      <span className="shrink-0 text-muted-foreground tabular">{listDate(i.lastDate)}</span>
                    </span>
                    {i.line !== null && <span className={cn("mt-0.5 block text-sm", quiet ? "text-muted-foreground" : "text-foreground")} data-testid="digest-line">{i.line}</span>}
                  </span>
                  {/* pass 3: at rest, so opening one is as visible as ticking it, its edge the Archive button's */}
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/open:text-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
    </div>
  );
}

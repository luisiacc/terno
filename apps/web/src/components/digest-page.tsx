import type { DigestItem, DigestRow } from "@terno/core";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Checkbox } from "@terno/ui/components/checkbox";
import { Spinner } from "@terno/ui/components/spinner";
import { ChevronRight } from "@terno/ui/icons";
import { cn } from "@terno/ui/lib/utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { digestTarget, modelName } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { deferred, trackJob, undoAction, undoActions } from "~/lib/actions";
import { registerUndo, snack, undoNow, useSnack } from "~/lib/snack";
import { whenDay } from "~/lib/when";
import { AiErrorNotice, aiErrorCopy, errorTarget } from "~/components/ai-error";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { digestPick, keepDigestPick, useToday } from "~/state/today";
import { AiProvenance } from "~/components/ai-provenance";

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
  // plan 162: the snack on screen carries this page's last Undo: the page doesn't show a second one beside it
  const lastUndo = batches?.at(-1)?.undo ?? null;
  const undoInSnack = useSnack((s) => lastUndo !== null && s.current?.action?.undo === lastUndo);
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
  const movedTo = useToday((s) => s.movedTo);
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
  // plan 162: the ticks reset at once, both ways (Atelier codex): every live row ticked, or none
  const anyTicked = chosen.length > 0;
  const tickAll = (on: boolean) => {
    const ids = shown.filter(live).map((i) => i.threadId);
    // a set means the unticked ones in a digest and the ticked ones in automated mail
    setToggled(new Set(on === automated ? ids : []));
  };
  const heading = useRef<HTMLHeadingElement>(null);
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
      // plan 162: the keys stay on the page (the button that had them is gone): the first row still here, else the title
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (at && at !== document.body && at.isConnected) return;
        const next = scroller.current?.querySelector<HTMLElement>("[data-digest-open]");
        (next ?? heading.current)?.focus({ preventScroll: true });
      });
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
  const failure = row.state === "failed" ? aiErrorCopy({ message: t("today.digest.failed"), kind: row.errorKind as never }, ai ? errorTarget(digestTarget(ai).provider, ai) : null) : null;
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
      className="mx-auto w-full max-w-(--reader-max,48rem) space-y-3 px-8 pb-8"
    >
      {/* plan 162: the header stays at the pane's top as the list scrolls under it, so the count and Archive are there when
          the review ends (they scrolled away), with the list's hairline under it; it starts where the page's title did */}
      <div aria-hidden className="h-12" />
      <header className="sticky top-0 z-10 -mx-8 mt-0! space-y-1.5 border-b border-hairline bg-background px-8 pt-4 pb-3" data-testid="digest-header">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none" data-testid="digest-title">{t(automated ? "today.digest.automatedTitle" : "today.digest.title")}</h1>
        {/* plan 162: what the batch is, said once, under the title (the day and a stray "·" sat beside the provenance) */}
        {!automated && items.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="digest-coverage">
            {t("today.digest.coverage", { count: items.length, date: whenDay(Math.min(...items.map((i) => i.lastDate))) })}
          </p>
        )}
        {/* the anatomy's action row: the primary, the quiet reset, what it'll do, and who wrote the lines at its end */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-1" data-testid="digest-actions">
          {(!finished || chosen.length > 0) && (
            // the count is what goes, always: what was opened or unticked isn't in it, and its row says so
            <Button size="sm" data-testid="digest-archive" disabled={!chosen.length} onClick={() => void archive()}>
              {automated ? t("today.digest.archiveSelected", { count: chosen.length }) : t("today.digest.archiveAll", { count: chosen.length })}
            </Button>
          )}
          {/* pass 2: done, its Undo here once the snack that carries the same one is gone (plan 162: one Undo at a time) */}
          {finished && done.undo && !undoInSnack && (
            <Button size="sm" variant="outline" className="text-foreground" data-testid="digest-undo" aria-label={t("today.digest.undoName")} onClick={() => undoNow(done.undo!)}>
              {t("common.undo")}
            </Button>
          )}
          {shown.some(live) && (
            <Button size="sm" variant="ghost" className="px-2 text-muted-foreground hover:text-foreground" data-testid="digest-tick-all" onClick={() => tickAll(!anyTicked)}>
              {t(anyTicked ? "today.digest.untickAll" : "today.digest.tickAll")}
            </Button>
          )}
          {finished ? (
            <p role="status" className="text-sm" data-testid="digest-done">
              {t(automated ? "today.digest.archivedSelected" : "today.digest.archived", { count: done.count })}.
              {shown.every((i) => stateOf(i) === "archived") && <span className="ml-1 text-muted-foreground" data-testid="digest-all-done">{t("today.digest.allDone")}</span>}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground tabular" data-testid="digest-count">
              {automated ? (
                chosen.length < shown.filter(live).length ? t("today.digest.countSelected", { count: shown.filter(live).length, selected: chosen.length }) : t("today.digest.automatedCount", { count: shown.filter(live).length })
              ) : (
                <>
                  {/* pass 2: what Archive will do, in words: how many go, and how many stay */}
                  <span className="font-medium text-foreground" data-testid="digest-to-archive">{t("today.digest.toArchive", { count: chosen.length })}</span>
                  {staying > 0 && <span data-testid="digest-staying"> · {t("today.digest.staying", { count: staying })}</span>}
                </>
              )}
            </p>
          )}
          {!automated && row.model && (
            // pass 3: who wrote the lines, the one control every AI surface has; plan 162: at the action row's end
            <AiProvenance model={row.model} at={0} detail={t("today.digest.writtenBy", { model: modelName(row.model) })} testId="digest-provenance" className="-me-1.5 ms-auto" />
          )}
        </div>
        {!finished && !automated && chosen.length > 0 && <p className="text-xs text-muted-foreground" data-testid="digest-tick-hint">{t("today.digest.tickHint")}</p>}
      </header>
      {row.state === "pending" && <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="digest-preparing"><Spinner className="size-3" /> {t("today.digest.preparing")}</p>}
      {row.state === "failed" && (
        // plan 162: the one AI error (ai-error.tsx), with Try again
        <div data-testid="digest-failed">
          <AiErrorNotice
            copy={failure!}
            textTestId="digest-failed-text"
            actions={<Button size="sm" variant="outline" data-testid="digest-retry" onClick={() => void client.call("today.digestRetry", {}).catch(() => {})}>{t("ask.tryAgain")}</Button>}
          />
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
        <ul>
          {shown.map((i) => {
            const state = stateOf(i);
            // owner's decisions (2): one sent to Trash or Spam from the reader says where it went, as its snack did
            const moved = state === "archived" ? movedTo.get(i.threadId) : undefined;
            const label = moved ? () => t(moved === "trash" ? "actions.done.trash" : "actions.done.spam") : automated && state === "keep" ? undefined : STATE_LABEL[state];
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

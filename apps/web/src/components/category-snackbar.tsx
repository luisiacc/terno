import { subjectTemplate, termsQuery, wordsQuery, type CategorizeScope, type CategoryColor, type QuickActions, type SimilarOffer, type SimilarOffers } from "@terno/core";
import type { CategorizeSource } from "@terno/core/rpc";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Kbd } from "@terno/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { formatList, t } from "@terno/i18n";
import { Check, Search } from "@terno/ui/icons";
import { useEffect, useId, useRef, useState } from "react";
import { fileAlways, filterNameOf, stopFiling, undoFiled, type Filed } from "~/lib/categorize";
import { chainUndo, filingOffers, isLatest, unchain } from "~/lib/offers";
import { offerWhat } from "~/lib/similar";
import { dismissSnack, patchSnack, pause, resume, runUndo, snack, useSnack, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { line, lineKey, OfferCount, OfferLine, OnlyLine, type Count } from "./offer-lines";
import { SnackClose, SnackMore, SnackPill } from "./snack-dock";

export { formatCount } from "./offer-lines";

const LIFETIME_MS = 10_000;

interface Controls {
  action(n: number): void;
  /** plan 91: 0, "No, only …" (when a default ran) */
  only?(): void;
  undo(): void;
  close(): void;
}
/** The keyboard (1–5, 0, z, Esc) drives whichever snackbar is up. */
export const snackbarControls: { current: Controls | null } = { current: null };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What 4 files, in words: the checked words (in the offer's order), else the
 * More… text, else how to start. A blank More… still files the words, so it
 * says the words.
 */
export function topicHelp(category: string, words: readonly string[], custom: string | null, from: string | null = null): string {
  const text = custom?.trim();
  if (text) return t("category.topicHelpQuery", { query: text, category });
  const list = formatList(words.map((word) => t("category.topicWord", { word })));
  // plan 89: checked words are a filter too (+ new mail), from the sender when "Only from" is on
  if (words.length) return from ? t("category.topicHelpFrom", { words: list, category, name: from }) : t("category.topicHelp", { words: list, category });
  return t("category.topicHelpEmpty", { category });
}

function titleOf(filed: Filed, name: string): string {
  return t(filed.moved ? "category.filed.moved" : "category.filed.added", { count: filed.threadIds.length, category: name });
}

/** Plan 91: where a move's default (the same sender and subject, moved too) runs: a drag and "Move to…", nothing additive. */
const DEFAULT_SOURCES = new Set<CategorizeSource>(["dnd", "picker"]);

let filings = 0;
/**
 * After any categorization (picker, accepted suggestion, drag and drop): one
 * line and Undo; the offers it makes obvious, one per line, behind Similar….
 * Its Undo and its z run `undo`, the same token as the global z.
 */
export function showCategorySnackbar(filed: Filed, undo: Undo, source: CategorizeSource = "picker"): void {
  const id = `filed-${++filings}`;
  const name = getApp().categories.find((c) => c.id === filed.categoryId)?.name ?? "";
  snack.custom({ id, message: titleOf(filed, name), duration: LIFETIME_MS, render: () => <CategorySnackbar id={id} filed={filed} undo={undo} source={source} /> });
}

/** Files a whole scope, with a progress snack that ends in "N added · Undo". */
export async function applyScope(categoryId: number, scope: CategorizeScope, move = false): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  const id = snack.loading(t(move ? "category.moving" : "category.adding", { category: name }));
  try {
    const { added, batchId } = await client.call("categorize.apply", { categoryId, scope, move });
    void reloadList({ keepSelection: true });
    snack.success(t(move ? "category.filed.moved" : "category.added", { count: added, category: name }), {
      id,
      duration: 8000,
      action: batchId === null ? undefined : { label: t("common.undo"), name: t("category.undoAdd", { category: name }), onClick: () => undoScope(categoryId, batchId, name) },
    });
  } catch (error) {
    snack.error(t("category.addFailed", { error: errorText(error) }), { id });
  }
}

/**
 * Undo of a bulk apply; a failure offers a retry (the undo is idempotent).
 * It can take a while: its outcome waits behind whatever the user did meanwhile.
 */
function undoScope(categoryId: number, batchId: number, name: string): void {
  undoFiled({ categoryId, addedIds: [], batchId }).then(
    (n) => void snack(t("category.removed", { count: n, category: name }), { background: true }),
    (error: unknown) =>
      void snack.error(t("category.undoFailed", { error: errorText(error) }), {
        background: true,
        action: { label: t("common.retry"), name: t("category.retryRemove", { category: name }), onClick: () => undoScope(categoryId, batchId, name) },
      }),
  );
}

/** Plan 91: the move's default, the same sender and subject moved too (and a filter for their new mail). */
interface Default {
  status: "running" | "done" | "failed";
  /** the conversations it moved besides the user's own */
  moved: number;
  /** "Future ones move to Facturas instead of Lecturas" */
  retargeted: string | null;
  /** the category the filter filed into before (no stop-filing offer for it: it files here now) */
  retargetedFrom: number | null;
  /** the group moved but the filter for new mail couldn't be saved */
  filterFailed: boolean;
  /** it changed something "only" can take back (a group moved, a filter made or turned on) */
  undoable: boolean;
  /** takes it back once (the filter, then the group's move); "only" and Undo share it */
  takeBack: () => Promise<void>;
  /** z's undo while it stands: it, then the move */
  token: Undo;
}

/** Runs `work` once, however many callers ask (a retry after a failure runs it again). */
function once(work: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => (done ??= work().catch((error: unknown) => {
    done = null;
    throw error;
  }));
}

type Line = { kind: "scope"; offer: SimilarOffer } | { kind: "words" };

function CategorySnackbar({ id, filed, undo, source }: { id: string; filed: Filed; undo: Undo; source: CategorizeSource }) {
  const category = useApp((s) => s.categories.find((c) => c.id === filed.categoryId));
  const [qa, setQa] = useState<QuickActions | null>(null);
  const [offers, setOffers] = useState<(SimilarOffers & { automated: boolean }) | null>(null);
  const [topicCount, setTopicCount] = useState<Count | "loading" | undefined>(undefined);
  const [terms, setTerms] = useState<Set<string>>(new Set());
  /** plan 89: the words only from this sender (on while there is one) */
  const [onlyFrom, setOnlyFrom] = useState(true);
  /** "More…": anything in the search language ("factura uber from:@uber.com") */
  const [custom, setCustom] = useState<string | null>(null);
  const [def, setDef] = useState<Default | null>(null);
  /** "No, only …" ran: the title says so */
  const [onlyDone, setOnlyDone] = useState(false);
  const [undoing, setUndoing] = useState(false);
  /** the undo failed: the snackbar is that error now, its pill a retry */
  const [failed, setFailed] = useState<string | null>(null);
  const close = () => dismissSnack(id);
  const current = () => useSnack.getState().current?.id === id;
  /** still the dock's snack (not fading out): only then do 1–5, 0, z and Esc drive it */
  const live = useSnack((s) => s.current?.id === id);
  const helpId = useId();
  const offersId = useId();
  /** plan 158: a success is one line; what could follow opens on asking */
  const [offersOpen, setOffersOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const refocusMore = useRef(false);
  /** z's undo for everything this snackbar stands for */
  // a failed default may have moved part of the group: its chain still takes that back (Codex review)
  const token = def ? def.token : undo;

  useEffect(() => {
    let alive = true;
    void client
      .call("categorize.quickActions", { categoryId: filed.categoryId, threadIds: filed.threadIds })
      .then((q) => {
        if (!alive) return;
        setQa(q);
        setTerms(new Set(q.terms.filter((x) => x.preselected).map((x) => x.term)));
      })
      .catch(() => {});
    void client
      .call("offers.forAction", { threadIds: filed.threadIds.slice(0, 200), action: { category: filed.categoryId } })
      .then((o) => {
        if (!alive) return;
        setOffers(o);
        maybeDefault(o);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filed]);

  /**
   * Plan 91: a drag or "Move to…" of an automated sender's mail moves the
   * rest with the same sender and subject too, and files their new mail. Only
   * while this is still the latest thing the user did (its undo is z's).
   */
  /** the offers counted again: what the default or "only" changed changes what each line would do */
  const recount = () =>
    void client.call("offers.forAction", { threadIds: filed.threadIds.slice(0, 200), action: { category: filed.categoryId } }).then(
      (o) => current() && setOffers(o),
      () => undefined,
    );

  const maybeDefault = (o: SimilarOffers & { automated: boolean }) => {
    const subject = o.offers.find((x) => x.scope.kind === "subject");
    if (!subject || subject.scope.kind !== "subject" || !(subject.count > 0 || subject.capped)) return;
    // every target checked (the backend reads at most 200): more than that gets no default (Codex review)
    if (!filed.moved || filed.threadIds.length > 200 || !DEFAULT_SOURCES.has(source) || !o.automated || !current() || !isLatest(undo)) return;
    const scope = subject.scope;
    const name = getApp().categories.find((c) => c.id === filed.categoryId)?.name ?? "";
    // what it did, known once the backend answers; z meanwhile waits for it, then takes it back
    let outcome!: (r: { batchId: number | null; filterUndo: number | null }) => void;
    const settled = new Promise<{ batchId: number | null; filterUndo: number | null }>((r) => (outcome = r));
    const takeBack = once(async () => {
      const u = await settled;
      if (u.filterUndo !== null) await client.call("similar.undo", { undoId: null, filterUndo: u.filterUndo });
      if (u.batchId !== null) await undoFiled({ categoryId: filed.categoryId, addedIds: [], batchId: u.batchId, moved: true });
    });
    const chained = chainUndo(takeBack, undo);
    setDef({ status: "running", moved: subject.count, retargeted: null, retargetedFrom: null, filterFailed: false, undoable: true, takeBack, token: chained });
    patchSnack(id, { message: t("offers.default.moving", { count: filed.threadIds.length + subject.count, category: name }) });
    void client
      .call("categorize.apply", { categoryId: filed.categoryId, scope, always: true, move: true, filterName: filterNameOf(scope, o.senderName, name) })
      .then(
        (r) => {
          outcome({ batchId: r.batchId, filterUndo: r.filter?.filterUndo ?? null });
          void reloadList({ keepSelection: true });
          const from = r.filter?.retargeted ? (getApp().categories.find((c) => c.id === r.filter!.retargeted!.from)?.name ?? null) : null;
          const undoable = r.added > 0 || r.filter?.filterUndo != null;
          setDef((d) => d && { ...d, status: "done", moved: r.added, retargeted: from, retargetedFrom: r.filter?.retargeted?.from ?? null, filterFailed: r.filterFailed, undoable });
          recount();
          // nothing else moved after all (filed meanwhile): the title stays the plain move, the note says new mail follows
          const message = r.added > 0 ? t("offers.default.moved", { count: filed.threadIds.length + r.added, category: name }) : titleOf(filed, name);
          // said aloud too: the whole group moved, not just the one dragged
          if (current()) patchSnack(id, { message }, true);
        },
        (error: unknown) => {
          // what moved before the failure stays undoable (the backend names it)
          const details = (error as { details?: { batchId?: unknown; filterUndo?: unknown } }).details;
          outcome({ batchId: typeof details?.batchId === "number" ? details.batchId : null, filterUndo: typeof details?.filterUndo === "number" ? details.filterUndo : null });
          setDef((d) => d && { ...d, status: "failed" });
          if (current()) patchSnack(id, { message: t("offers.default.failed", { error: errorText(error) }), tone: "error" }, true);
        },
      );
  };

  /**
   * Plan 90: a move took mail out of categories where Terno's filters may
   * still file mail like it: a line offers to stop them, once the default (if
   * any) settled; not for the category whose filter it just retargeted here.
   */
  const [stops, setStops] = useState<{ categoryId: number; name: string; ids: number[] } | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !offers || def?.status === "running" || !filed.left?.length || filed.threadIds.length > 200) return;
    asked.current = true;
    const from = def?.retargetedFrom ?? null;
    void (async () => {
      for (const c of filed.left!.filter((x) => x !== from && x !== filed.categoryId).slice(0, 3)) {
        const r = await client.call("filters.autoFor", { categoryId: c, threadIds: filed.threadIds }).catch(() => ({ filters: [] }));
        const name = getApp().categories.find((x) => x.id === c)?.name;
        if (r.filters.length && name && current()) return setStops({ categoryId: c, name, ids: r.filters.map((f) => f.id) });
      }
    })();
  }, [offers, def?.status]);

  // the topic recounts as words are toggled or typed (debounced)
  const topic: CategorizeScope | null = (() => {
    if (!qa) return null;
    const text = custom?.trim();
    if (text) return { kind: "query", query: text };
    // in the offer's order; a filter as well as a search (plan 89)
    if (terms.size) return { kind: "words", terms: qa.terms.map((x) => x.term).filter((x) => terms.has(x)), email: onlyFrom && qa.sender ? qa.sender.email : null };
    return null;
  })();
  const topicKey = topic ? JSON.stringify(topic) : null;
  useEffect(() => {
    // no counting for lines nobody opened
    if (!topic || !offersOpen) {
      setTopicCount(undefined);
      return;
    }
    let alive = true;
    setTopicCount("loading");
    const timer = setTimeout(() => {
      void client
        .call("categorize.count", { categoryId: filed.categoryId, scope: topic })
        .then((r) => alive && setTopicCount(r))
        .catch(() => alive && setTopicCount({ count: 0, capped: false }));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [topicKey, offersOpen]);

  // an undo in flight holds the countdown (and lets it go if the snackbar leaves first)
  useEffect(() => {
    if (!undoing) return;
    pause("busy");
    return () => resume("busy");
  }, [undoing]);

  // Esc in More… brings More… back, and focus with it
  useEffect(() => {
    if (custom !== null || !refocusMore.current) return;
    refocusMore.current = false;
    moreRef.current?.focus();
  }, [custom]);

  /** "View": the topic as a search, so the user sees exactly what would be added. */
  const view = () => {
    if (!topic || !category) return;
    close();
    const query = `${topic.kind === "words" ? wordsQuery(topic) : topic.kind === "query" ? topic.query : ""} ${termsQuery([], category.name)}`;
    // exactly the scope bulk apply uses: all accounts, no category or review view on top
    setApp({ query, view: "all", categoryId: null, accountId: null, reviewCategoryId: null, selectedId: null });
  };

  // the default's own scope isn't offered again
  const shown = filingOffers(offers?.offers ?? []).filter((o) => !(def && def.status !== "failed" && o.scope.kind === "subject"));
  const lines: Line[] = [...shown.map((offer) => ({ kind: "scope" as const, offer })), ...(qa?.terms.length || qa?.sender ? [{ kind: "words" as const }] : [])];
  const busy = def?.status === "running";

  /**
   * Every line files now and catches future mail (plans 81, 84), even with
   * nothing left now; a More… search only files what's there. After a move
   * it moves (plan 91); Undo then takes back the newest first.
   */
  const run = (l: Line | undefined) => {
    // not while "only" takes the default back: the chain this would join is being retired (Codex review)
    if (!l || !category || busy || undoing) return;
    const original = token.state === "ready" ? token : undefined;
    if (l.kind === "words") {
      if (!topic) return;
      if (topic.kind === "query") {
        // still counting is no reason to ignore Enter (the backend resolves it anyway); only a known nothing is
        if (topicCount && topicCount !== "loading" && topicCount.count === 0 && !topicCount.capped) return;
        close();
        void applyScope(filed.categoryId, topic, filed.moved);
        return;
      }
      close();
      // after a move, the words move their mail too (Codex review)
      void fileAlways(filed.categoryId, topic, null, filterNameOf(topic, qa?.sender?.name ?? null, category.name), { original, move: filed.moved });
      return;
    }
    const scope = l.offer.scope;
    close();
    // wider than the default (everything from them, their domain): its filter replaces the default's, which goes first
    const replaces = def?.status === "done" && (scope.kind === "sender" || scope.kind === "domain");
    void fileAlways(filed.categoryId, scope, null, filterNameOf(scope, offers?.senderName ?? null, category.name), { original, move: filed.moved, before: replaces ? () => def.takeBack() : undefined });
  };

  /** "No, only move this email": the default comes back (the group, the filter); the user's own move stays, z takes that back. */
  const only = () => {
    if (!def || def.status !== "done" || !def.undoable || undoing) return;
    setUndoing(true);
    def.takeBack().then(
      () => {
        unchain(def.token, undo);
        setUndoing(false);
        setDef(null);
        setOnlyDone(true);
        recount();
        void reloadList({ keepSelection: true });
        if (current()) patchSnack(id, { message: t("offers.only.done", { count: filed.threadIds.length, category: category?.name ?? "" }) }, true);
      },
      (error: unknown) => {
        setUndoing(false);
        if (current()) patchSnack(id, { message: t("category.undoFailed", { error: errorText(error) }), tone: "error" }, true);
      },
    );
  };

  /**
   * Closes only once the backend undid it; a failure turns the snackbar into
   * the error, with a retry (the undo is idempotent). A snackbar replaced
   * meanwhile leaves the newer snack alone.
   */
  const doUndo = () => {
    if (undoing || token.state !== "ready") return;
    setUndoing(true);
    runUndo(token).then(
      () => {
        if (!current()) return;
        close();
        snack(t("category.undone", { category: category?.name ?? "" }), { duration: 3000 });
      },
      (error: unknown) => {
        if (!current()) return;
        setUndoing(false);
        const text = t("category.undoFailed", { error: errorText(error) });
        setFailed(text);
        patchSnack(id, { message: text, tone: "error" }, true);
      },
    );
  };

  useEffect(() => {
    if (!live) return;
    // a number with its lines closed opens them: nothing runs that the user can't read first
    snackbarControls.current = { action: (n) => (offersOpen ? run(lines[n - 1]) : setOffersOpen(true)), only, undo: doUndo, close };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  if (!category) return null;
  const help = topicHelp(category.name, qa ? qa.terms.filter((x) => terms.has(x.term)).map((x) => x.term) : [], custom, topic?.kind === "words" && topic.email ? (qa?.sender?.name ?? topic.email) : null);
  const senderName = offers?.senderName ?? qa?.sender?.name ?? null;
  const title = failed ?? (def?.status === "running" ? t("offers.default.moving", { count: filed.threadIds.length + def.moved, category: category.name }) : def?.status === "done" && def.moved > 0 ? t("offers.default.moved", { count: filed.threadIds.length + def.moved, category: category.name }) : onlyDone ? t("offers.only.done", { count: filed.threadIds.length, category: category.name }) : titleOf(filed, category.name));
  const note =
    def?.status === "done"
      ? def.filterFailed
        ? t("offers.default.noFilter")
        : def.retargeted
          ? t("offers.default.retargeted", { category: category.name, from: def.retargeted })
          : t("offers.default.future")
      : null;
  const onlyShown = def?.status === "done" && def.undoable;
  return (
    <div data-testid="category-snackbar" data-failed={failed ? "" : undefined} data-default={def?.status}>
      <div className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3 text-sm">
        <CategoryDot color={category.color as CategoryColor} />
        {/* a default's title is a sentence read whole: it wraps to a second line rather than cut */}
        <span className={cn("line-clamp-2 min-w-0 flex-1", failed ? "text-destructive-ink" : "font-medium")} data-testid="snackbar-title" title={title}>
          {title}
        </span>
        {(lines.length > 0 || stops) && <SnackMore open={offersOpen} onToggle={() => setOffersOpen((o) => !o)} controls={offersId} />}
        {(filed.batchId !== null || def) && (
          <SnackPill
            testId="snackbar-undo"
            label={failed ? t("common.retry") : t("common.undo")}
            name={failed ? t("category.retryUndo", { title }) : t("category.undoTitle", { title })}
            shortcut="z"
            disabled={undoing || busy}
            onClick={doUndo}
          />
        )}
        <SnackClose onClick={close} />
      </div>
      {note && (
        <p data-testid="snackbar-note" className="-mt-1.5 truncate pr-3 pb-1 pl-8 text-2xs text-muted-foreground">
          {note}
        </p>
      )}
      {(offersOpen ? lines.length > 0 || stops || onlyShown : onlyShown) && (
        <div id={offersId} data-testid="snackbar-offers" className="flex flex-col px-1.5 pb-1.5">
          {offersOpen && lines.map((l, i) =>
            l.kind === "scope" ? (
              <OfferLine
                key={l.offer.scope.kind}
                n={i + 1}
                testId={`snackbar-${l.offer.scope.kind}`}
                label={t(filed.moved ? "offers.line.move" : "offers.line.add", { what: offerWhat(l.offer, senderName, true), category: category.name })}
                help={offerHelp(l.offer, senderName, category.name)}
                future
                disabled={busy || undoing}
                // the sender with nothing left now: the line is about their future mail, no "0"
                count={l.offer.count === 0 && !l.offer.capped ? undefined : l.offer}
                onClick={() => run(l)}
              />
            ) : (
              qa && (
                // not one button: its words, More… and View are controls of their own; the words get a line of their own, under the label
                <div key="words" className="flex min-w-0 flex-col text-xs" data-testid="snackbar-topic">
                  <div className="flex h-7 min-w-0 items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => run(l)}
                            // stays focusable with nothing checked, so its help is still there to read
                            aria-disabled={!topic || busy || undoing || undefined}
                            aria-describedby={helpId}
                            className={cn(line, "flex-1 text-left aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent")}
                            data-testid="snackbar-topic-apply"
                          />
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">{t("category.topic")}</span>
                        {topic?.kind === "words" && (
                          <span data-testid="snackbar-topic-future" className="text-2xs whitespace-nowrap text-muted-foreground">
                            {t("category.newMailToo")}
                          </span>
                        )}
                        <Kbd className={lineKey}>{i + 1}</Kbd>
                      </TooltipTrigger>
                      <TooltipContent align="start" data-testid="snackbar-topic-help">
                        {help}
                      </TooltipContent>
                    </Tooltip>
                    <span id={helpId} hidden>
                      {help}
                    </span>
                    <div className="flex shrink-0 items-center gap-2 pr-1.5 empty:hidden">
                      {topic && (
                        <button type="button" data-testid="snackbar-view" onClick={view} className="inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-2xs text-primary hover:bg-muted">
                          <Search className="size-3" /> {t("common.view")}
                        </button>
                      )}
                      {topic && <OfferCount count={topicCount} testId="snackbar-topic-count" />}
                    </div>
                  </div>
                  {/* on the label's line */}
                  <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1 pr-1.5 pb-1 pl-1.5">
                    {custom === null ? (
                      <>
                        {qa.terms.map(({ term }) => (
                          <button
                            key={term}
                            type="button"
                            data-testid="snackbar-term"
                            aria-pressed={terms.has(term)}
                            onClick={() =>
                              setTerms((s) => {
                                const n = new Set(s);
                                if (n.has(term)) n.delete(term);
                                else n.add(term);
                                return n;
                              })
                            }
                            className={cn(
                              "inline-flex h-5 max-w-full items-center gap-0.5 rounded-full px-1.5 text-2xs",
                              terms.has(term) ? "bg-accent text-accent-foreground" : "bg-tint text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <span className="truncate">{term}</span>
                            {terms.has(term) && <Check className="size-2.5 shrink-0" />}
                          </button>
                        ))}
                        {qa.sender && (
                          // plan 89: the words from this sender only, or from anyone
                          <button
                            type="button"
                            data-testid="snackbar-only-from"
                            aria-pressed={onlyFrom}
                            onClick={() => setOnlyFrom((v) => !v)}
                            className={cn(
                              "inline-flex h-5 max-w-full items-center gap-0.5 rounded-full px-1.5 text-2xs",
                              onlyFrom ? "bg-accent text-accent-foreground" : "bg-tint text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <span className="truncate">{t("category.onlyFrom", { name: qa.sender.name })}</span>
                            {onlyFrom && <Check className="size-2.5 shrink-0" />}
                          </button>
                        )}
                        <button ref={moreRef} type="button" data-testid="snackbar-more" onClick={() => setCustom("")} className="h-5 rounded-full px-1.5 text-2xs text-muted-foreground hover:text-foreground">
                          {t("category.more")}
                        </button>
                      </>
                    ) : (
                      <input
                        autoFocus
                        data-testid="snackbar-query"
                        aria-label={t("category.topicName")}
                        value={custom}
                        placeholder={t("category.topicPlaceholder")}
                        onChange={(e) => setCustom(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") run(l);
                          if (e.key === "Escape") {
                            // focus goes back to More…, not out of the snackbar
                            refocusMore.current = true;
                            setCustom(null);
                          }
                        }}
                        className="h-5 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                      />
                    )}
                  </div>
                </div>
              )
            ),
          )}
          {offersOpen && stops && (
            <button
              type="button"
              data-testid="snackbar-stop"
              onClick={() => {
                close();
                void stopFiling(stops.ids, stops.name);
              }}
              className={cn(line, "w-full text-left text-muted-foreground hover:text-foreground")}
            >
              {t("filters.stop.line", { category: stops.name })}
            </button>
          )}
          {/* a default moved more than was asked: taking that back is never behind a fold */}
          {onlyShown && <OnlyLine label={t("offers.only.move", { count: filed.threadIds.length })} onClick={only} disabled={undoing} />}
        </div>
      )}
    </div>
  );
}

/** What a line does, in full: its tooltip and its description. */
function offerHelp(o: SimilarOffer, senderName: string | null, category: string): string {
  const s = o.scope;
  switch (s.kind) {
    case "subject":
      return t("category.helpSubject", { name: senderName || s.email, subject: subjectTemplate(s.subject), category });
    case "sender":
      return t("category.helpSender", { name: senderName || s.email, category });
    case "domain":
      return t("category.helpDomain", { domain: s.domain, category });
    case "list":
      return t("category.helpList", { list: s.listId, category });
  }
}

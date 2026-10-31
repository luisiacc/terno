import { isFilterable, termsQuery, type CategorizeScope, type CategoryColor, type QuickActions } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Kbd } from "@terno/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { formatList, formatNumber, t } from "@terno/i18n";
import { Check, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { fileAlways, filterNameOf, undoFiled, type Filed } from "~/lib/categorize";
import { dismissSnack, patchSnack, pause, resume, runUndo, snack, useSnack, type Undo } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { SnackClose, SnackPill } from "./snack-dock";

const LIFETIME_MS = 10_000;

interface Controls {
  action(n: number): void;
  undo(): void;
  close(): void;
}
/** The keyboard (1–5, z, Esc) drives whichever snackbar is up. */
export const snackbarControls: { current: Controls | null } = { current: null };

type Slot = "sender" | "domain" | "list" | "topic";
type Count = { count: number; capped: boolean } | null;

/** "1,000+" at the cap; a scope read only in part (plan 63) says "at least" the same way */
export const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? `${formatNumber(c.count)}+` : formatNumber(c.count));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What 4 files, in words: the checked words (in the offer's order), else the
 * More… text, else how to start. A blank More… still files the words, so it
 * says the words.
 */
export function topicHelp(category: string, words: readonly string[], custom: string | null): string {
  const text = custom?.trim();
  if (text) return t("category.topicHelpQuery", { query: text, category });
  if (words.length) return t("category.topicHelp", { words: formatList(words.map((word) => t("category.topicWord", { word }))), category });
  return t("category.topicHelpEmpty", { category });
}

function titleOf(filed: Filed, name: string): string {
  return t(filed.moved ? "category.filed.moved" : "category.filed.added", { count: filed.threadIds.length, category: name });
}

let filings = 0;
/**
 * After any categorization (picker, accepted suggestion, drag and drop): the
 * bulk actions it makes obvious, as the dock's snack in two compact rows. Its
 * Undo and its z run `undo`, the same token as the global z.
 */
export function showCategorySnackbar(filed: Filed, undo: Undo): void {
  const id = `filed-${++filings}`;
  const name = getApp().categories.find((c) => c.id === filed.categoryId)?.name ?? "";
  snack.custom({ id, message: titleOf(filed, name), duration: LIFETIME_MS, render: () => <CategorySnackbar id={id} filed={filed} undo={undo} /> });
}

/** Files a whole scope, with a progress snack that ends in "N added · Undo". */
export async function applyScope(categoryId: number, scope: CategorizeScope): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  const id = snack.loading(t("category.adding", { category: name }));
  try {
    const { added, batchId } = await client.call("categorize.apply", { categoryId, scope });
    void reloadList({ keepSelection: true });
    snack.success(t("category.added", { count: added, category: name }), {
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

const chip = "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-tint pr-2 pl-1 text-xs whitespace-nowrap transition-colors duration-fast hover:bg-muted";

export function Chip({ n, label, count, onClick, testId, title }: { n: number; label: string; count?: Count | "loading"; onClick: () => void; testId: string; title?: string }) {
  if (count === null) return null;
  return (
    <span data-testid={testId} className="inline-flex shrink-0">
      <button type="button" onClick={onClick} className={chip} title={title}>
        <Kbd className="h-4 min-w-4 rounded-full bg-background text-2xs shadow-none">{n}</Kbd>
        <span>{label}</span>
        {count === "loading" ? (
          <span data-testid="snackbar-count-loading" className="h-3 w-5 animate-pulse rounded bg-muted" />
        ) : count ? (
          <span data-testid={`${testId}-count`} className="font-mono text-2xs text-muted-foreground tabular">
            · {formatCount(count)}
          </span>
        ) : null}
      </button>
    </span>
  );
}

/** The chips' row: one line that scrolls sideways (the wheel too), fading at the edge that has more. */
export function Strip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setMore((m) => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      return m.left === left && m.right === right ? m : { left, right };
    });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, []);
  const fade = `linear-gradient(to right, ${more.left ? "transparent, black 20px" : "black"}, ${more.right ? "black calc(100% - 20px), transparent" : "black"})`;
  return (
    <div
      ref={ref}
      data-testid="snackbar-strip"
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
      className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      {children}
    </div>
  );
}

const key = "h-4 min-w-4 shrink-0 rounded-full bg-tint text-2xs shadow-none";
const line = "flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-fast hover:bg-muted";

/** An offer's count: right-aligned so the column lines up; a pulse while counting. */
function OfferCount({ count, testId }: { count: Count | "loading" | undefined; testId: string }) {
  if (count === undefined) return null;
  if (count === "loading") return <span data-testid="snackbar-count-loading" className="h-3 w-5 shrink-0 animate-pulse rounded bg-muted" />;
  return (
    <span data-testid={testId} className="shrink-0 font-mono text-2xs text-muted-foreground tabular">
      {count ? formatCount(count) : formatNumber(0)}
    </span>
  );
}

/**
 * One offer per line, so its whole label shows (a long name truncates). Plan
 * 81: 1–3 also catch future mail; a quiet "+ new mail" says so, the tooltip
 * (and the description) says it in full.
 */
function Offer({ n, label, count, onClick, testId, help }: { n: number; label: string; count?: Count | "loading"; onClick: () => void; testId: string; help: string }) {
  const helpId = useId();
  if (count === null) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<button type="button" data-testid={testId} onClick={onClick} aria-describedby={helpId} className={cn(line, "w-full text-left")} />}>
          <Kbd className={key}>{n}</Kbd>
          <span className="min-w-0 truncate">{label}</span>
          <span data-testid={`${testId}-future`} className="flex-1 shrink-0 text-2xs whitespace-nowrap text-muted-foreground">
            {t("category.newMailToo")}
          </span>
          <OfferCount count={count} testId={`${testId}-count`} />
        </TooltipTrigger>
        <TooltipContent align="start" data-testid={`${testId}-help`}>
          {help}
        </TooltipContent>
      </Tooltip>
      <span id={helpId} hidden>
        {help}
      </span>
    </>
  );
}

function CategorySnackbar({ id, filed, undo }: { id: string; filed: Filed; undo: Undo }) {
  const category = useApp((s) => s.categories.find((c) => c.id === filed.categoryId));
  const [qa, setQa] = useState<QuickActions | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Slot, Count | "loading">>>({});
  const [terms, setTerms] = useState<Set<string>>(new Set());
  /** "More…": anything in the search language ("factura uber from:@uber.com") */
  const [custom, setCustom] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  /** the undo failed: the snackbar is that error now, its pill a retry */
  const [failed, setFailed] = useState<string | null>(null);
  const close = () => dismissSnack(id);
  const current = () => useSnack.getState().current?.id === id;
  /** still the dock's snack (not fading out): only then do 1–5, z and Esc drive it */
  const live = useSnack((s) => s.current?.id === id);
  const helpId = useId();
  const moreRef = useRef<HTMLButtonElement>(null);
  const refocusMore = useRef(false);

  const scopes = (): Partial<Record<Slot, CategorizeScope>> => {
    if (!qa || !category) return {};
    const out: Partial<Record<Slot, CategorizeScope>> = {};
    if (qa.sender) out.sender = { kind: "sender", email: qa.sender.email };
    if (qa.domain) out.domain = { kind: "domain", domain: qa.domain };
    if (qa.list) out.list = { kind: "list", listId: qa.list };
    const text = custom?.trim();
    if (text) out.topic = { kind: "query", query: text };
    else if (terms.size) out.topic = { kind: "query", query: termsQuery([...terms], category.name) };
    return out;
  };

  useEffect(() => {
    let alive = true;
    void client
      .call("categorize.quickActions", { categoryId: filed.categoryId, threadIds: filed.threadIds })
      .then((q) => {
        if (!alive) return;
        setQa(q);
        setTerms(new Set(q.terms.filter((t) => t.preselected).map((t) => t.term)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filed]);

  // counts stream in lazily, one per chip; a domain or list with nothing left to add hides, the sender stays (its future mail)
  useEffect(() => {
    if (!qa) return;
    let alive = true;
    const s = scopes();
    for (const slot of ["sender", "domain", "list"] as const) {
      const scope = s[slot];
      if (!scope) continue;
      setCounts((c) => ({ ...c, [slot]: "loading" }));
      void client
        .call("categorize.count", { categoryId: filed.categoryId, scope })
        .then((r) => alive && setCounts((c) => ({ ...c, [slot]: r.count || slot === "sender" ? r : null })))
        .catch(() => alive && setCounts((c) => ({ ...c, [slot]: slot === "sender" ? undefined : null })));
    }
    return () => {
      alive = false;
    };
  }, [qa]);

  // the topic recounts as words are toggled or typed (debounced)
  const topicQuery = (() => {
    const t = scopes().topic;
    return t?.kind === "query" ? t.query : null;
  })();
  useEffect(() => {
    if (!topicQuery) {
      setCounts((c) => ({ ...c, topic: undefined }));
      return;
    }
    let alive = true;
    setCounts((c) => ({ ...c, topic: "loading" }));
    const t = setTimeout(() => {
      void client
        .call("categorize.count", { categoryId: filed.categoryId, scope: { kind: "query", query: topicQuery } })
        .then((r) => alive && setCounts((c) => ({ ...c, topic: r })))
        .catch(() => alive && setCounts((c) => ({ ...c, topic: { count: 0, capped: false } })));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [topicQuery]);

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
    if (!topicQuery || !category) return;
    close();
    const query = custom?.trim() ? `${custom.trim()} ${termsQuery([], category.name)}` : topicQuery;
    // exactly the scope bulk apply uses: all accounts, no category or review view on top
    setApp({ query, view: "all", categoryId: null, accountId: null, reviewCategoryId: null, selectedId: null });
  };

  /** 1–3 file now and catch future mail (plan 81), even with nothing left now; 4 (words) only files what's there. */
  const run = (slot: Slot) => {
    const scope = scopes()[slot];
    const count = counts[slot];
    if (!scope || !category || count === null || count === "loading") return;
    if (isFilterable(scope)) {
      close();
      void fileAlways(filed.categoryId, scope, null, filterNameOf(scope, qa?.sender?.name ?? null, category.name));
      return;
    }
    if (!count || count.count === 0) return;
    close();
    void applyScope(filed.categoryId, scope);
  };
  /**
   * Closes only once the backend undid it; a failure turns the snackbar into
   * the error, with a retry (the undo is idempotent). A snackbar replaced
   * meanwhile leaves the newer snack alone.
   */
  const doUndo = () => {
    if (undoing || undo.state !== "ready") return;
    setUndoing(true);
    runUndo(undo).then(
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
    snackbarControls.current = {
      action: (n) => {
        const slot = (["sender", "domain", "list", "topic"] as const)[n - 1];
        if (slot) run(slot);
      },
      undo: doUndo,
      close,
    };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  // a domain or list with no mail beyond this sender's adds nothing now: one line says it (capped counts can't tell)
  const sameAsSender = (slot: "domain" | "list") => {
    const a = counts[slot];
    const b = counts.sender;
    return !!a && !!b && a !== "loading" && b !== "loading" && !a.capped && !b.capped && a.count === b.count;
  };
  if (!category) return null;
  const title = titleOf(filed, category.name);
  const help = topicHelp(category.name, qa ? qa.terms.filter((x) => terms.has(x.term)).map((x) => x.term) : [], custom);
  const offers = qa && (qa.sender || qa.domain || qa.list || qa.terms.length);
  // the sender with nothing left now: the line is about their future mail, no "0"
  const senderCount = counts.sender && counts.sender !== "loading" && counts.sender.count === 0 ? undefined : counts.sender;
  return (
    <div data-testid="category-snackbar" data-failed={failed ? "" : undefined}>
      <div className="flex h-9 items-center gap-2 pr-1.5 pl-3 text-sm">
        <CategoryDot color={category.color as CategoryColor} />
        <span className={cn("min-w-0 flex-1 truncate", failed ? "text-destructive-ink" : "font-medium")} data-testid="snackbar-title" title={failed ?? title}>
          {failed ?? title}
        </span>
        {filed.batchId !== null && (
          <SnackPill
            testId="snackbar-undo"
            label={failed ? t("common.retry") : t("common.undo")}
            name={failed ? t("category.retryUndo", { title }) : t("category.undoTitle", { title })}
            shortcut="z"
            disabled={undoing}
            onClick={doUndo}
          />
        )}
        <SnackClose onClick={close} />
      </div>
      {offers && (
        <div data-testid="snackbar-offers" className="flex flex-col px-1.5 pb-1.5">
          {qa.sender && (
            <Offer
              n={1}
              testId="snackbar-sender"
              label={t("threadMenu.allFrom", { name: qa.sender.name })}
              help={t("category.helpSender", { name: qa.sender.name, category: category.name })}
              count={senderCount}
              onClick={() => run("sender")}
            />
          )}
          {qa.domain && !sameAsSender("domain") && (
            <Offer
              n={2}
              testId="snackbar-domain"
              label={t("category.chip.domain", { domain: qa.domain })}
              help={t("category.helpDomain", { domain: qa.domain, category: category.name })}
              count={counts.domain}
              onClick={() => run("domain")}
            />
          )}
          {qa.list && !sameAsSender("list") && (
            <Offer n={3} testId="snackbar-list" label={t("category.chip.list", { list: qa.list })} help={t("category.helpList", { list: qa.list, category: category.name })} count={counts.list} onClick={() => run("list")} />
          )}
          {/* not one button: its words, More… and View are controls of their own; the words get a line of their own, under the label */}
          <div className="flex min-w-0 flex-col text-xs" data-testid="snackbar-topic">
            <div className="flex h-7 min-w-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => run("topic")}
                      // stays focusable with nothing checked, so its help is still there to read
                      aria-disabled={!topicQuery || undefined}
                      aria-describedby={helpId}
                      className={cn(line, "flex-1 text-left aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent")}
                      data-testid="snackbar-topic-apply"
                    />
                  }
                >
                  <Kbd className={key}>4</Kbd>
                  {t("category.topic")}
                </TooltipTrigger>
                <TooltipContent align="start" data-testid="snackbar-topic-help">{help}</TooltipContent>
              </Tooltip>
              <span id={helpId} hidden>
                {help}
              </span>
              <div className="flex shrink-0 items-center gap-2 pr-1.5">
                {topicQuery && (
                  <button type="button" data-testid="snackbar-view" onClick={view} className="inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-2xs text-primary hover:bg-muted">
                    <Search className="size-3" /> {t("common.view")}
                  </button>
                )}
                {topicQuery && <OfferCount count={counts.topic} testId="snackbar-topic-count" />}
              </div>
            </div>
            {/* indented to the label: the line's padding, the key and the gap */}
            <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-1 pr-1.5 pb-1 pl-7.5">
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
                    if (e.key === "Enter") run("topic");
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
        </div>
      )}
    </div>
  );
}

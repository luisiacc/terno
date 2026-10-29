import { termsQuery, type CategorizeScope, type CategoryColor, type QuickActions } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Kbd } from "@terno/ui/components/kbd";
import { cn } from "@terno/ui/lib/utils";
import { formatNumber, t } from "@terno/i18n";
import { Check, Filter, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { undoFiled, type Filed } from "~/lib/categorize";
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

export const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? `${formatNumber(1000)}+` : formatNumber(c.count));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  // counts stream in lazily, one per chip; a chip with nothing left to add hides
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
        .then((r) => alive && setCounts((c) => ({ ...c, [slot]: r.count ? r : null })))
        .catch(() => alive && setCounts((c) => ({ ...c, [slot]: null })));
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

  /** "View": the topic as a search, so the user sees exactly what would be added. */
  const view = () => {
    if (!topicQuery || !category) return;
    close();
    const query = custom?.trim() ? `${custom.trim()} ${termsQuery([], category.name)}` : topicQuery;
    // exactly the scope bulk apply uses: all accounts, no category or review view on top
    setApp({ query, view: "all", categoryId: null, accountId: null, reviewCategoryId: null, selectedId: null });
  };

  const run = (slot: Slot) => {
    const scope = scopes()[slot];
    const count = counts[slot];
    if (!scope || !count || count === "loading" || count.count === 0) return;
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
  const always = () => {
    if (!qa?.filterDraft) return;
    close();
    void client
      .call("filters.save", { name: `${qa.filterDraft.name} → ${category?.name ?? ""}`.slice(0, 120), enabled: true, source: "manual", rule: qa.filterDraft.rule })
      .then(() => void snack.success(t("category.filterCreated"), { action: { label: t("common.edit"), name: t("category.editFilter"), onClick: () => setApp({ dialog: "filters" }) } }))
      .catch((e: unknown) => void snack.error(t("category.filterFailed", { error: errorText(e) })));
  };

  useEffect(() => {
    if (!live) return;
    snackbarControls.current = {
      action: (n) => (n === 5 ? always() : run((["sender", "domain", "list", "topic"] as const)[n - 1]!)),
      undo: doUndo,
      close,
    };
    setApp({ snackbar: true });
    return () => {
      snackbarControls.current = null;
      setApp({ snackbar: false });
    };
  });

  // a domain or list with no mail beyond this sender's adds nothing: one chip says it
  const sameAsSender = (slot: "domain" | "list") => {
    const a = counts[slot];
    const b = counts.sender;
    return !!a && !!b && a !== "loading" && b !== "loading" && a.count === b.count && a.capped === b.capped;
  };
  if (!category) return null;
  const title = titleOf(filed, category.name);
  const offers = qa && (qa.sender || qa.domain || qa.list || qa.filterDraft || qa.terms.length);
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
        <Strip>
          {qa.sender && <Chip n={1} testId="snackbar-sender" label={t("threadMenu.allFrom", { name: qa.sender.name })} count={counts.sender} onClick={() => run("sender")} />}
          {qa.domain && !sameAsSender("domain") && <Chip n={2} testId="snackbar-domain" label={t("category.chip.domain", { domain: qa.domain })} count={counts.domain} onClick={() => run("domain")} />}
          {qa.list && !sameAsSender("list") && <Chip n={3} testId="snackbar-list" label={t("category.chip.list", { list: qa.list })} count={counts.list} onClick={() => run("list")} />}
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-tint pr-1 pl-1 text-xs whitespace-nowrap" data-testid="snackbar-topic">
            <button type="button" onClick={() => run("topic")} disabled={!topicQuery} className="inline-flex items-center gap-1.5 rounded-full pr-0.5 disabled:opacity-60" data-testid="snackbar-topic-apply">
              <Kbd className="h-4 min-w-4 rounded-full bg-background text-2xs shadow-none">4</Kbd>
              {t("category.topic")}
            </button>
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
                      "inline-flex h-4.5 items-center gap-0.5 rounded-full px-1.5 text-2xs",
                      terms.has(term) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {term}
                    {terms.has(term) && <Check className="size-2.5" />}
                  </button>
                ))}
                <button type="button" data-testid="snackbar-more" onClick={() => setCustom("")} className="px-1 text-2xs text-muted-foreground hover:text-foreground">
                  {t("category.more")}
                </button>
              </>
            ) : (
              <input
                autoFocus
                data-testid="snackbar-query"
                aria-label={t("category.topicPlaceholder")}
                value={custom}
                placeholder={t("category.topicPlaceholder")}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") run("topic");
                  if (e.key === "Escape") setCustom(null);
                }}
                className="h-5 w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            )}
            {topicQuery && counts.topic !== undefined && (
              <span data-testid="snackbar-topic-count" className="font-mono text-2xs text-muted-foreground tabular">
                {counts.topic === "loading" ? "·" : counts.topic ? `· ${formatCount(counts.topic)}` : "· 0"}
              </span>
            )}
            {topicQuery && (
              <button type="button" data-testid="snackbar-view" onClick={view} className="inline-flex h-4.5 items-center gap-1 rounded-full px-1.5 text-2xs text-primary hover:bg-muted">
                <Search className="size-3" /> {t("common.view")}
              </button>
            )}
          </span>
          {qa.filterDraft && (
            <span data-testid="snackbar-filter" className="inline-flex shrink-0">
              <button type="button" onClick={always} className={chip}>
                <Kbd className="h-4 min-w-4 rounded-full bg-background text-2xs shadow-none">5</Kbd>
                <Filter className="size-3 text-muted-foreground" /> {t("category.alwaysFilter")}
              </button>
            </span>
          )}
        </Strip>
      )}
    </div>
  );
}

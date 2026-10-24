import { termsQuery, type CategorizeScope, type CategoryColor, type QuickActions } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Kbd } from "@unica/ui/components/kbd";
import { cn } from "@unica/ui/lib/utils";
import { Check, Filter, Search, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { undoFiled, type Filed } from "~/lib/categorize";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";

const LIFETIME_MS = 10_000;

/** At most one snackbar; a new categorization replaces it. */
const useSnackbar = create<{ filed: Filed | null; seq: number }>(() => ({ filed: null, seq: 0 }));

interface Controls {
  action(n: number): void;
  undo(): void;
  close(): void;
}
/** The keyboard (1–5, z, Esc) drives whichever snackbar is up. */
export const snackbarControls: { current: Controls | null } = { current: null };

type Slot = "sender" | "domain" | "list" | "topic";
type Count = { count: number; capped: boolean } | null;

const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? "1 000+" : c.count.toLocaleString("es-MX"));

/** After any categorization (picker, accepted suggestion, drag and drop): the bulk actions it makes obvious. */
export function showCategorySnackbar(filed: Filed): void {
  useSnackbar.setState((s) => ({ filed, seq: s.seq + 1 }));
}

/**
 * Its own fixed layer rather than a toast: it grows as counts and words
 * arrive, and a toast stack measures its height once.
 */
export function CategorySnackbarHost() {
  const { filed, seq } = useSnackbar();
  if (!filed) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-50 flex">
      <div className="pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-2 duration-slow">
        <CategorySnackbar key={seq} filed={filed} onClose={() => useSnackbar.setState((s) => (s.seq === seq ? { filed: null } : s))} />
      </div>
    </div>
  );
}

/** Files a whole scope, with a progress toast that ends in "N añadidas · Deshacer". */
export async function applyScope(categoryId: number, scope: CategorizeScope): Promise<void> {
  const name = getApp().categories.find((c) => c.id === categoryId)?.name ?? "";
  const id = toast.loading(`Añadiendo a ${name}…`);
  try {
    const { added, batchId } = await client.call("categorize.apply", { categoryId, scope });
    void reloadList({ keepSelection: true });
    toast.success(`${added.toLocaleString("es-MX")} ${added === 1 ? "añadida" : "añadidas"} a ${name}`, {
      id,
      duration: 8000,
      action: batchId === null ? undefined : { label: "Deshacer", onClick: () => undoScope(categoryId, batchId, name) },
    });
  } catch (error) {
    toast.error(`No se pudo añadir: ${error instanceof Error ? error.message : error}`, { id });
  }
}

/** Undo of a bulk apply; a failure offers a retry (the undo is idempotent). */
function undoScope(categoryId: number, batchId: number, name: string): void {
  undoFiled({ categoryId, addedIds: [], batchId }).then(
    (n) => toast(`${n} quitadas de ${name}`),
    (error: unknown) => toast.error(`No se pudo deshacer: ${error instanceof Error ? error.message : error}`, { action: { label: "Reintentar", onClick: () => undoScope(categoryId, batchId, name) } }),
  );
}

function Chip({ n, label, count, onClick, testId, children }: { n: number; label: string; count?: Count | "loading"; onClick: () => void; testId: string; children?: React.ReactNode }) {
  if (count === null) return null;
  return (
    <span data-testid={testId} className="inline-flex h-7 max-w-full items-center rounded-md bg-background text-xs shadow-raised">
      <button type="button" onClick={onClick} className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Kbd className="h-4 min-w-4 text-2xs">{n}</Kbd>
        <span className="truncate">{label}</span>
        {count === "loading" ? (
          <span data-testid="snackbar-count-loading" className="h-3 w-5 animate-pulse rounded bg-muted" />
        ) : count ? (
          <span data-testid={`${testId}-count`} className="font-mono text-2xs whitespace-nowrap text-muted-foreground tabular">
            · {formatCount(count)}
          </span>
        ) : null}
      </button>
      {children}
    </span>
  );
}

function CategorySnackbar({ filed, onClose }: { filed: Filed; onClose: () => void }) {
  const category = useApp((s) => s.categories.find((c) => c.id === filed.categoryId));
  const [qa, setQa] = useState<QuickActions | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Slot, Count | "loading">>>({});
  const [terms, setTerms] = useState<Set<string>>(new Set());
  /** "Más…": anything in the search language ("factura uber from:@uber.com") */
  const [custom, setCustom] = useState<string | null>(null);
  // hover and focus pause the lifetime independently: typing must not expire when the pointer leaves
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const left = useRef(LIFETIME_MS);
  const close = onClose;

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

  /** "Ver": the topic as a search, so the user sees exactly what would be added. */
  const view = () => {
    if (!topicQuery || !category) return;
    close();
    const query = custom?.trim() ? `${custom.trim()} ${termsQuery([], category.name)}` : topicQuery;
    // exactly the scope bulk apply uses: all accounts, no category or review view on top
    setApp({ query, view: "all", categoryId: null, accountId: null, reviewCategoryId: null, selectedId: null });
  };

  // own lifetime: 10 s, paused while hovered or focused
  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const t = setTimeout(close, left.current);
    return () => {
      clearTimeout(t);
      left.current -= performance.now() - started;
    };
  }, [paused]);

  const run = (slot: Slot) => {
    const scope = scopes()[slot];
    const count = counts[slot];
    if (!scope || !count || count === "loading" || count.count === 0) return;
    close();
    void applyScope(filed.categoryId, scope);
  };
  const [undoing, setUndoing] = useState(false);
  /** Closes only once the backend undid it; a failure keeps the snackbar (and offers a retry). */
  const undo = () => {
    if (undoing) return;
    setUndoing(true);
    undoFiled(filed).then(
      () => {
        close();
        toast(`Deshecho: ${category?.name ?? ""}`, { duration: 3000 });
      },
      (error: unknown) => {
        setUndoing(false);
        toast.error(`No se pudo deshacer: ${error instanceof Error ? error.message : error}`, { id: `undo-${filed.batchId}`, action: { label: "Reintentar", onClick: undo } });
      },
    );
  };
  const always = () => {
    if (!qa?.filterDraft) return;
    close();
    void client
      .call("filters.save", { name: `${qa.filterDraft.name} → ${category?.name ?? ""}`.slice(0, 120), enabled: true, source: "manual", rule: qa.filterDraft.rule })
      .then(() => toast.success("Filtro creado", { action: { label: "Editar", onClick: () => setApp({ dialog: "filters" }) } }))
      .catch((e: unknown) => toast.error(`No se pudo crear el filtro: ${e instanceof Error ? e.message : e}`));
  };

  useEffect(() => {
    snackbarControls.current = {
      action: (n) => (n === 5 ? always() : run((["sender", "domain", "list", "topic"] as const)[n - 1]!)),
      undo,
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
  const many = filed.threadIds.length > 1;
  return (
    <div
      data-testid="category-snackbar"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="w-[min(560px,calc(100vw-2rem))] rounded-xl bg-popover p-3 text-popover-foreground shadow-popover"
    >
      <div className="flex items-center gap-2 text-sm">
        <CategoryDot color={category.color as CategoryColor} />
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="snackbar-title">
          {filed.moved
            ? many
              ? `${filed.threadIds.length} conversaciones movidas a ${category.name}`
              : `Movido a ${category.name}`
            : many
              ? `${filed.threadIds.length} conversaciones añadidas a ${category.name}`
              : `Añadido a ${category.name}`}
        </span>
        {filed.batchId !== null && (
          <button type="button" data-testid="snackbar-undo" disabled={undoing} onClick={undo} className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Undo2 className="size-3.5" /> Deshacer <Kbd className="h-4 min-w-4 text-2xs">z</Kbd>
          </button>
        )}
        <button type="button" aria-label="Cerrar" onClick={close} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      {qa && (qa.sender || qa.domain || qa.list || qa.filterDraft) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {qa.sender && <Chip n={1} testId="snackbar-sender" label={`Todo de ${qa.sender.name}`} count={counts.sender} onClick={() => run("sender")} />}
          {qa.domain && !sameAsSender("domain") && <Chip n={2} testId="snackbar-domain" label={`Todo de @${qa.domain}`} count={counts.domain} onClick={() => run("domain")} />}
          {qa.list && !sameAsSender("list") && <Chip n={3} testId="snackbar-list" label={`Lista ${qa.list}`} count={counts.list} onClick={() => run("list")} />}
          {qa.filterDraft && (
            <span data-testid="snackbar-filter" className="inline-flex h-7 items-center rounded-md border border-dashed border-border text-xs">
              <button type="button" onClick={always} className="inline-flex h-full items-center gap-1.5 rounded-md px-2 hover:bg-muted">
                <Kbd className="h-4 min-w-4 text-2xs">5</Kbd>
                <Filter className="size-3 text-muted-foreground" /> Siempre → filtro
              </button>
            </span>
          )}
        </div>
      )}
      {qa && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="snackbar-topic">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background pr-1 pl-2 text-xs">
            <button type="button" onClick={() => run("topic")} disabled={!topicQuery} className="inline-flex items-center gap-1.5 disabled:opacity-60" data-testid="snackbar-topic-apply">
              <Kbd className="h-4 min-w-4 text-2xs">4</Kbd>
              Sobre:
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
                      "inline-flex h-5 items-center gap-0.5 rounded-full border px-1.5 text-2xs",
                      terms.has(term) ? "border-primary/40 bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {term}
                    {terms.has(term) && <Check className="size-2.5" />}
                  </button>
                ))}
                <button type="button" data-testid="snackbar-more" onClick={() => setCustom("")} className="px-1 text-2xs text-muted-foreground hover:text-foreground">
                  Más…
                </button>
              </>
            ) : (
              <input
                autoFocus
                data-testid="snackbar-query"
                value={custom}
                placeholder="Añadir todo lo que hable de…"
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") run("topic");
                  if (e.key === "Escape") setCustom(null);
                }}
                className="h-5 w-56 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            )}
            {topicQuery && counts.topic !== undefined && (
              <span data-testid="snackbar-topic-count" className="font-mono text-2xs whitespace-nowrap text-muted-foreground tabular">
                {counts.topic === "loading" ? "·" : counts.topic ? `· ${formatCount(counts.topic)}` : "· 0"}
              </span>
            )}
            {topicQuery && (
              <button type="button" data-testid="snackbar-view" onClick={view} className="ml-0.5 inline-flex h-5 items-center gap-1 rounded px-1 text-2xs text-primary hover:bg-muted">
                <Search className="size-3" /> Ver
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

import { termsQuery, type CategorizeScope, type CategoryColor, type QuickActions } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Kbd } from "@unica/ui/components/kbd";
import { Filter, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { undoFiled, type Filed } from "~/lib/categorize";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";

const TOAST_ID = "category-snackbar";
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

const formatCount = (c: { count: number; capped: boolean }) => (c.capped ? "1 000+" : c.count.toLocaleString("es-MX"));

/** After any categorization (picker, accepted suggestion, drag and drop): the bulk actions it makes obvious. */
export function showCategorySnackbar(filed: Filed): void {
  toast.custom((id) => <CategorySnackbar key={`${filed.categoryId}:${filed.batchId}:${filed.threadIds.join(",")}`} filed={filed} toastId={id} />, {
    id: TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    unstyled: true,
  });
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
      action: batchId === null ? undefined : { label: "Deshacer", onClick: () => void undoFiled({ categoryId, addedIds: [], batchId }).then((n) => toast(`${n} quitadas de ${name}`)) },
    });
  } catch (error) {
    toast.error(`No se pudo añadir: ${error instanceof Error ? error.message : error}`, { id });
  }
}

function Chip({ n, label, count, onClick, testId, children }: { n: number; label: string; count?: Count | "loading"; onClick: () => void; testId: string; children?: React.ReactNode }) {
  if (count === null) return null;
  return (
    <span data-testid={testId} className="inline-flex h-7 max-w-full items-center rounded-md border border-border bg-background text-xs shadow-xs">
      <button type="button" onClick={onClick} className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Kbd className="h-4 min-w-4 text-2xs">{n}</Kbd>
        <span className="truncate">{label}</span>
        {count === "loading" ? (
          <span data-testid="snackbar-count-loading" className="h-3 w-5 animate-pulse rounded bg-muted" />
        ) : count ? (
          <span data-testid={`${testId}-count`} className="font-mono text-2xs text-muted-foreground tabular">
            · {formatCount(count)}
          </span>
        ) : null}
      </button>
      {children}
    </span>
  );
}

function CategorySnackbar({ filed, toastId }: { filed: Filed; toastId: string | number }) {
  const category = useApp((s) => s.categories.find((c) => c.id === filed.categoryId));
  const [qa, setQa] = useState<QuickActions | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Slot, Count | "loading">>>({});
  const [terms, setTerms] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const left = useRef(LIFETIME_MS);
  const close = () => toast.dismiss(toastId);

  const scopes = (): Partial<Record<Slot, CategorizeScope>> => {
    if (!qa || !category) return {};
    const out: Partial<Record<Slot, CategorizeScope>> = {};
    if (qa.sender) out.sender = { kind: "sender", email: qa.sender.email };
    if (qa.domain) out.domain = { kind: "domain", domain: qa.domain };
    if (qa.list) out.list = { kind: "list", listId: qa.list };
    if (terms.size) out.topic = { kind: "query", query: termsQuery([...terms], category.name) };
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
    if (!scope || !counts[slot] || counts[slot] === "loading") return;
    close();
    void applyScope(filed.categoryId, scope);
  };
  const undo = () => {
    close();
    void undoFiled(filed).then(() => toast(`Deshecho: ${category?.name ?? ""}`, { duration: 3000 }));
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
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className="w-[min(560px,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-center gap-2 text-sm">
        <CategoryDot color={category.color as CategoryColor} />
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="snackbar-title">
          {many ? `${filed.threadIds.length} conversaciones añadidas a ${category.name}` : `Añadido a ${category.name}`}
        </span>
        {filed.batchId !== null && (
          <button type="button" data-testid="snackbar-undo" onClick={undo} className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Undo2 className="size-3.5" /> Deshacer <Kbd className="h-4 min-w-4 text-2xs">z</Kbd>
          </button>
        )}
        <button type="button" aria-label="Cerrar" onClick={close} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      {qa && (qa.sender || qa.domain || qa.list || qa.terms.length > 0 || qa.filterDraft) && (
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
    </div>
  );
}

import { useState } from "react";
import type { CategoryColor, View } from "@unica/core";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Shortcut } from "@unica/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@unica/ui/components/tooltip";
import { cn } from "@unica/ui/lib/utils";
import { Archive, Inbox, Layers, OctagonAlert, PenLine, Plus, Send, Settings2, Sparkles, Star, Trash2 } from "lucide-react";
import { openCompose } from "~/lib/actions";
import { VIEW_LABEL } from "~/lib/format";
import { navigate, setApp, useApp } from "~/state/app";
import { client } from "~/rpc/connection";
import { CATEGORY_COLORS } from "@unica/core";
import { toast } from "sonner";
import { LocalPill } from "./local-pill";

const VIEWS: { view: View; icon: typeof Inbox; keys?: string }[] = [
  { view: "inbox", icon: Inbox, keys: "g i" },
  { view: "starred", icon: Star, keys: "g s" },
  { view: "sent", icon: Send, keys: "g t" },
  { view: "archive", icon: Archive, keys: "g a" },
  { view: "all", icon: Layers },
  { view: "spam", icon: OctagonAlert },
  { view: "trash", icon: Trash2, keys: "g #" },
];

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      onClick={onClick}
      className={cn(
        "group flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-sidebar-foreground/85 transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground",
      )}
    >
      <span className="flex size-4 items-center justify-center text-sidebar-foreground/60 group-data-active:text-sidebar-primary">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className="font-mono text-2xs tabular text-sidebar-foreground/60">{count}</span> : null}
    </button>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-5 mb-1 flex h-5 items-center justify-between px-2">
      <span className="text-2xs font-medium tracking-wide text-sidebar-foreground/50 uppercase">{children}</span>
      {action}
    </div>
  );
}

export function Sidebar() {
  const view = useApp((s) => s.view);
  const accountId = useApp((s) => s.accountId);
  const categoryId = useApp((s) => s.categoryId);
  const reviewCategoryId = useApp((s) => s.reviewCategoryId);
  const accounts = useApp((s) => s.accounts);
  const categories = useApp((s) => s.categories);
  const counts = useApp((s) => s.counts);

  const [creating, setCreating] = useState(false);
  const createCategory = async (name: string) => {
    setCreating(false);
    if (!name.trim()) return;
    try {
      const color = CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]!;
      const c = await client.call("categories.create", { name: name.trim(), color });
      navigate({ categoryId: c.id });
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <aside data-testid="sidebar" className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="drag-region h-11 shrink-0 [.is-mac_&]:pl-[76px]" />
      <div className="px-3 pb-2">
        <Button data-testid="compose-button" className="no-drag w-full justify-start gap-2" onClick={() => openCompose("new")}>
          <PenLine />
          <span className="flex-1 text-left">Escribir</span>
          <Shortcut keys="c" className="opacity-70 [&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground" />
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {VIEWS.map(({ view: v, icon: Icon, keys }) => (
          <Tooltip key={v}>
            <TooltipTrigger
              render={
                <NavItem
                  testId={`nav-${v}`}
                  active={categoryId === null && view === v}
                  onClick={() => navigate({ view: v })}
                  icon={<Icon className="size-4" />}
                  label={VIEW_LABEL[v]!}
                  count={v === "inbox" ? (accountId ? counts.inboxUnreadByAccount[accountId] : counts.inboxUnread) : undefined}
                />
              }
            />
            {keys && (
              <TooltipContent side="right">
                <Shortcut keys={keys} />
              </TooltipContent>
            )}
          </Tooltip>
        ))}

        <SectionTitle
          action={
            <button type="button" data-testid="new-category" aria-label="Nueva categoría" onClick={() => setCreating(true)} className="rounded p-0.5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground">
              <Plus className="size-3.5" />
            </button>
          }
        >
          Categorías
        </SectionTitle>
        {categories.map((c) => (
          <div key={c.id}>
            <NavItem
              testId={`nav-category-${c.id}`}
              active={categoryId === c.id && reviewCategoryId === null}
              onClick={() => navigate({ categoryId: c.id })}
              icon={<CategoryDot color={c.color as CategoryColor} />}
              label={c.name}
              count={counts.categoryUnread[c.id] || undefined}
            />
            {(counts.categorySuggestions[c.id] ?? 0) > 0 && (
              <button
                type="button"
                data-testid={`nav-review-${c.id}`}
                data-active={reviewCategoryId === c.id || undefined}
                onClick={() => navigate({ view: "all", reviewCategoryId: c.id })}
                className="flex h-6 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
              >
                <Sparkles className="size-3 text-sidebar-primary" />
                <span className="flex-1">Revisar</span>
                <span className="font-mono text-2xs tabular">{counts.categorySuggestions[c.id]}</span>
              </button>
            )}
          </div>
        ))}
        {creating && (
          <input
            autoFocus
            data-testid="new-category-input"
            placeholder="Nombre de la categoría"
            className="mt-0.5 h-7 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            onBlur={(e) => void createCategory(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createCategory(e.currentTarget.value);
              if (e.key === "Escape") setCreating(false);
            }}
          />
        )}
        {categories.length === 0 && !creating && <p className="px-2 py-1 text-xs text-sidebar-foreground/50">Agrupa correos de todas tus cuentas.</p>}

        <SectionTitle>Cuentas</SectionTitle>
        <NavItem
          testId="nav-account-all"
          active={accountId === null}
          onClick={() => navigate({ accountId: null, view })}
          icon={<Layers className="size-3.5" />}
          label="Todas las cuentas"
        />
        {accounts.map((a) => (
          <NavItem
            key={a.id}
            testId={`nav-account-${a.id}`}
            active={accountId === a.id}
            onClick={() => navigate({ accountId: a.id, view: categoryId ? "inbox" : view })}
            icon={
              <span className="relative">
                <CategoryDot color={a.color as CategoryColor} />
                {a.syncState.status === "syncing" && <span className="absolute -inset-0.5 animate-ping rounded-full bg-sidebar-primary/40" />}
              </span>
            }
            label={a.displayName}
            count={counts.inboxUnreadByAccount[a.id] || undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => setApp({ dialog: "addAccount" })}
          className="mt-0.5 flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Plus className="size-4" /> Añadir cuenta
        </button>
      </nav>
      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2">
        <Button data-testid="open-filters" variant="ghost" size="sm" className="flex-1 justify-start gap-2 text-sidebar-foreground/80" onClick={() => setApp({ dialog: "filters" })}>
          <Sparkles className="text-sidebar-primary" /> Filtros
        </Button>
        <LocalPill />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="open-settings" variant="ghost" size="icon-sm" aria-label="Ajustes" onClick={() => setApp({ dialog: "settings", settingsTab: "general" })}>
                <Settings2 />
              </Button>
            }
          />
          <TooltipContent>Ajustes</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}

import { shortcutsFor, type CategoryColor, type Command, type ThreadAction, type ThreadSummary, type View } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@unica/ui/components/context-menu";
import {
  Archive,
  CheckCheck,
  Copy,
  Filter,
  Forward,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
  OctagonAlert,
  Plus,
  Reply,
  ReplyAll,
  Search,
  ShieldCheck,
  Star,
  StarOff,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { act, openCompose, targetRows } from "~/lib/actions";
import { addScopeToCategory, addToCategory, isExclusivelyIn, moveToCategory, removeFromCategory } from "~/lib/categorize";
import { rowSelector, setRule } from "~/lib/flash";
import { renderProbe } from "~/lib/render-probe";
import { isMac, selectAll } from "~/lib/select";
import { menuTargets } from "~/lib/selection";
import { getApp, setApp, useApp, type ScopeSelection } from "~/state/app";
import { listKey, useList } from "~/state/list";
import { applyScope } from "./category-snackbar";
import { listScroller } from "./thread-list";

/** What the open menu acts on: explicit threads, or a "select all N" scope. Set at right-click; rows never read it. */
interface MenuTarget {
  ids: number[];
  scope: ScopeSelection | null;
}
const useMenuTarget = create<MenuTarget>(() => ({ ids: [], scope: null }));

const GLYPH: Record<string, string> = { shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", escape: "esc", backspace: "⌫", delete: "⌦", arrowup: "↑", arrowdown: "↓" };
/** "mod+shift+u" → "⌘⇧U" (Ctrl+Shift+U off Mac), "g i" → "G I". */
function glyphs(keys: string): string {
  return keys
    .split(" ")
    .map((chord) =>
      chord
        .split("+")
        .map((k) => (k === "mod" ? (isMac ? "⌘" : "Ctrl+") : (GLYPH[k] ?? (isMac || k.length === 1 ? k.toUpperCase() : `${k[0]!.toUpperCase()}${k.slice(1)}+`))))
        .join(""),
    )
    .join(" ");
}
const hint = (command: Command) => {
  const keys = shortcutsFor(command, undefined, isMac)[0];
  return keys ? <ContextMenuShortcut>{glyphs(keys)}</ContextMenuShortcut> : null;
};

/** Where the right-click landed: the selection when the row is part of it, else that row alone (the selection stays). */
function targetFor(row: number): MenuTarget {
  const s = getApp();
  if (s.scope && s.scope.key === listKey()) return { ids: [], scope: s.scope };
  const { items, index } = useList.getState();
  return { ids: menuTargets(row, s.checked, { ids: items.map((t) => t.id), index }), scope: null };
}

/** Where ⇧F10 opens: on the selection when there is one (the open thread if it is part of it, else its first row), else the open thread. */
export function menuAnchor(selectedId: number | null, checked: ReadonlySet<number>, index: ReadonlyMap<number, number>): number | null {
  if (checked.size === 0) return selectedId;
  if (selectedId !== null && checked.has(selectedId)) return selectedId;
  let first: number | null = null;
  for (const id of checked) if (index.has(id) && (first === null || index.get(id)! < index.get(first)!)) first = id;
  return first;
}

/**
 * ⇧F10 / the ContextMenu key: the menu opens on the selection (or the open
 * thread), as a right-click there would (the row is scrolled into view first).
 */
export function openMenuForSelection(): void {
  const s = getApp();
  const id = menuAnchor(s.selectedId, s.checked, useList.getState().index);
  if (id === null) return;
  const i = useList.getState().index.get(id);
  if (i === undefined) return;
  listScroller.scrollToIndex?.(i);
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[role=listbox] [data-thread-id="${Math.trunc(id)}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: Math.round(r.left + 24), clientY: Math.round(r.top + r.height / 2), button: 2 }));
  });
}

/**
 * The thread context menu: one Base UI ContextMenu around the whole list (no
 * per-row trigger, so opening it renders no row). The clicked row gets a
 * ring from a keyed CSS rule; global shortcuts wait while it is open.
 */
export function ThreadMenu({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setApp({ menuOpen: next });
        if (!next) setRule("menu-target", null);
      }}
    >
      <ContextMenuTrigger
        render={children}
        onContextMenu={(e) => {
          const el = (e.target as Element).closest<HTMLElement>("[data-thread-id]");
          if (!el) {
            // empty space under the rows: no menu
            (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
            return;
          }
          if (import.meta.env.VITE_RENDER_PROBE) performance.mark("menu:open");
          const row = Number(el.dataset.threadId);
          const target = targetFor(row);
          useMenuTarget.setState(target);
          // the ring follows the row's inset, rounded selection shape
          setRule("menu-target", `${rowSelector([row], "::before")}{box-shadow:inset 0 0 0 2px var(--ring)}`);
        }}
      />
      <ContextMenuContent className="w-64" data-testid="thread-menu">
        <MenuItems />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Item({ icon, label, command, onClick, disabled, testId, variant }: { icon: ReactNode; label: string; command?: Command; onClick: () => void; disabled?: boolean; testId: string; variant?: "destructive" }) {
  return (
    <ContextMenuItem data-testid={testId} disabled={disabled} onClick={onClick} variant={variant}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {command && hint(command)}
    </ContextMenuItem>
  );
}

/** One sender shared by every target (case-insensitive), or null. */
function sharedSender(rows: readonly ThreadSummary[]): { email: string; name: string } | null {
  const first = rows[0];
  if (!first?.fromEmail) return null;
  const email = first.fromEmail.toLowerCase();
  return rows.every((t) => t.fromEmail.toLowerCase() === email) ? { email, name: first.fromName || first.fromEmail } : null;
}

/** The view decides the third group: what "out of here" means in Archivo, Papelera and Spam. */
function placeItems(view: View, run: (a: ThreadAction) => void) {
  const archive = { icon: <Archive />, label: "Archivar", command: "thread.archive" as Command, onClick: () => run("archive"), testId: "menu-archive" };
  const trash = { icon: <Trash2 />, label: "Eliminar", command: "thread.trash" as Command, onClick: () => run("trash"), testId: "menu-trash", variant: "destructive" as const };
  const spam = { icon: <OctagonAlert />, label: "Marcar como spam", command: "thread.spam" as Command, onClick: () => run("spam"), testId: "menu-spam" };
  const toInbox = (label: string) => ({ icon: <Inbox />, label, onClick: () => run("moveToInbox"), testId: "menu-inbox" });
  switch (view) {
    case "trash":
      return [toInbox("Restaurar a Entrada"), { ...archive, disabled: true }, { ...trash, disabled: true }, spam];
    case "spam":
      return [{ icon: <ShieldCheck />, label: "No es spam", onClick: () => run("notSpam"), testId: "menu-not-spam" }, { ...archive, disabled: true }, trash, { ...spam, disabled: true }];
    case "archive":
      return [toInbox("Mover a Entrada"), { ...archive, disabled: true }, trash, spam];
    case "inbox":
      return [archive, trash, spam];
    default:
      return [archive, trash, spam, toInbox("Mover a Entrada")];
  }
}

function MenuItems() {
  renderProbe("ThreadMenu");
  const { ids, scope } = useMenuTarget();
  const categories = useApp((s) => s.categories);
  const view = useApp((s) => (s.query.trim() && /(^|\s)(in|en):/.test(s.query) ? "all" : s.view));
  const rows = scope ? useList.getState().items : targetRows(ids);
  const single = !scope && ids.length === 1 ? rows[0] : undefined;
  const run = (action: ThreadAction) => void act(action, scope ? undefined : ids);
  const anyUnread = scope !== null || rows.some((t) => t.unread);
  const anyRead = scope !== null || rows.some((t) => !t.unread);
  const anyStarred = scope !== null || rows.some((t) => t.starred);
  const anyPlain = scope !== null || rows.some((t) => !t.starred);
  const sender = scope ? null : sharedSender(rows);
  const reply = (mode: "reply" | "replyAll" | "forward") => {
    if (!single) return;
    // the menu's own thread, passed explicitly (the selection follows, it isn't read back)
    setApp({ selectedId: single.id, readerOpen: true });
    void openCompose(mode, single.id);
  };
  const inAll = (categoryId: number) => rows.length > 0 && rows.every((t) => t.categoryIds.includes(categoryId));
  const toggleCategory = (categoryId: number) => {
    if (scope) return void addScopeToCategory(categoryId, scope);
    if (inAll(categoryId)) void removeFromCategory(categoryId, ids);
    else void addToCategory(categoryId, ids, { source: "picker" });
  };
  const picker = (mode: "toggle" | "move") => {
    // the picker acts on the checked rows or the open thread: make the menu's target that selection
    if (!scope && ids.length === 1) setApp({ selectedId: ids[0]!, checked: getApp().checked.has(ids[0]!) ? getApp().checked : new Set() });
    setApp({ dialog: "categoryPicker", pickerMode: mode });
  };
  const count = scope ? scope.count : ids.length;

  return (
    <>
      {count > 1 && (
        <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground" data-testid="menu-count">
          {scope ? `Las ${count.toLocaleString("es-MX")} conversaciones de ${scope.label}` : `${count} conversaciones`}
        </div>
      )}
      {single && (
        <>
          <Item icon={<Reply />} label="Responder" command="compose.reply" onClick={() => reply("reply")} testId="menu-reply" />
          <Item icon={<ReplyAll />} label="Responder a todos" command="compose.replyAll" onClick={() => reply("replyAll")} testId="menu-reply-all" />
          <Item icon={<Forward />} label="Reenviar" command="compose.forward" onClick={() => reply("forward")} testId="menu-forward" />
          <ContextMenuSeparator />
        </>
      )}
      {anyUnread && <Item icon={<MailOpen />} label="Marcar como leído" command="thread.markRead" onClick={() => run("markRead")} testId="menu-read" />}
      {anyRead && <Item icon={<Mail />} label="Marcar como no leído" command="thread.markUnread" onClick={() => run("markUnread")} testId="menu-unread" />}
      {anyPlain && <Item icon={<Star />} label="Destacar" command="thread.star" onClick={() => run("star")} testId="menu-star" />}
      {anyStarred && <Item icon={<StarOff />} label="Quitar destacado" command={anyPlain ? undefined : "thread.star"} onClick={() => run("unstar")} testId="menu-unstar" />}
      <ContextMenuSeparator />
      {placeItems(view, run).map((it) => (
        <Item key={it.testId} {...it} />
      ))}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-categories">
          <Tag />
          <span className="flex-1">Categorías</span>
          {hint("thread.category")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56" data-testid="menu-categories-list">
          {categories.map((c) => (
            <ContextMenuCheckboxItem key={c.id} data-testid={`menu-category-${c.id}`} checked={!scope && inAll(c.id)} closeOnClick onClick={() => toggleCategory(c.id)}>
              <CategoryDot color={c.color as CategoryColor} />
              <span className="truncate">{c.name}</span>
            </ContextMenuCheckboxItem>
          ))}
          {categories.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem data-testid="menu-category-new" onClick={() => picker("toggle")}>
            <Plus /> Nueva categoría…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-move" disabled={scope !== null}>
          <FolderInput />
          <span className="flex-1">Mover a…</span>
          {hint("thread.move")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56" data-testid="menu-move-list">
          {categories.map((c) => (
            <ContextMenuItem key={c.id} data-testid={`menu-move-${c.id}`} disabled={isExclusivelyIn(c.id, ids)} onClick={() => void moveToCategory(c.id, ids, { source: "picker" })}>
              <CategoryDot color={c.color as CategoryColor} />
              <span className="truncate">{c.name}</span>
            </ContextMenuItem>
          ))}
          {categories.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem data-testid="menu-move-new" onClick={() => picker("move")}>
            <Plus /> Nueva categoría…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {sender && (
        <>
          <ContextMenuSeparator />
          {categories.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger data-testid="menu-sender-file">
                <UserRound />
                <span className="min-w-0 flex-1 truncate">Todo de {sender.name}</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-56" data-testid="menu-sender-file-list">
                {categories.map((c) => (
                  <ContextMenuItem key={c.id} data-testid={`menu-sender-file-${c.id}`} onClick={() => void applyScope(c.id, { kind: "sender", email: sender.email })}>
                    <CategoryDot color={c.color as CategoryColor} />
                    <span className="truncate">A {c.name}</span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <Item
            icon={<Filter />}
            label="Crear filtro desde este remitente…"
            testId="menu-filter"
            onClick={() => setApp({ dialog: "filters", filterPrefill: { name: `De ${sender.name}`, rule: { match: "all", conditions: [{ field: "from", op: "equals", value: sender.email }], actions: [{ type: "archive" }] } } })}
          />
          <Item icon={<Search />} label={`Buscar correos de ${sender.name}`} testId="menu-search-sender" onClick={() => setApp({ query: `from:${sender.email}`, view: "all", categoryId: null, reviewCategoryId: null, checked: new Set(), scope: null })} />
          <Item
            icon={<Copy />}
            label="Copiar dirección"
            testId="menu-copy"
            onClick={() =>
              void navigator.clipboard.writeText(sender.email).then(
                () => toast(`Copiado: ${sender.email}`, { duration: 2000 }),
                () => toast.error("No se pudo copiar"),
              )
            }
          />
        </>
      )}
      <ContextMenuSeparator />
      <Item icon={<CheckCheck />} label="Seleccionar todo" command="list.selectAll" onClick={selectAll} testId="menu-select-all" />
    </>
  );
}

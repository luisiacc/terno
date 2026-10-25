import type { CategoryColor } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@terno/ui/components/command";
import { Archive, CheckCheck, FileDown, FolderInput, Inbox, Layers, ListFilter, Mail, MailOpen, Moon, OctagonAlert, PenLine, Printer, RefreshCw, RotateCw, Search, Send, Sparkles, Star, Sun, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { act, openCompose, toggleStar, undoLast } from "~/lib/actions";
import { addScopeToCategory, addToCategory } from "~/lib/categorize";
import { currentTargets, isMac, selectAll } from "~/lib/select";
import { updateAppearance } from "~/lib/appearance";
import { printCommand } from "~/lib/print-open";
import { toggleUnreadFilter } from "~/lib/unread";
import { isUnreadOnly } from "~/lib/unread-filter";
import { checkForUpdates, installUpdate, useHasUpdates, useUpdates } from "~/lib/updates";
import { navigate, setApp, useApp } from "~/state/app";
import { SETTINGS_TABS } from "./settings/tabs";

export function CommandPalette() {
  const open = useApp((s) => s.dialog === "palette");
  const categories = useApp((s) => s.categories);
  const accounts = useApp((s) => s.accounts);
  // what the actions and "Añadir a" apply to: all N of a view, the checked threads, else the selected one
  const targets = useApp((s) => (open ? (s.scope ? s.scope.count : s.checked.size ? s.checked.size : s.selectedId !== null ? 1 : 0) : 0));
  // printing takes the conversation the reader shows (one, with no new message in the pane)
  const printable = useApp((s) => open && s.selectedId !== null && !s.scope && s.checked.size < 2 && s.compose === null);
  // the unread filter applies to a mailbox (not "Revisar")
  const filter = useApp((s) => (open && s.reviewCategoryId === null ? (isUnreadOnly(s) ? "on" : "off") : null));
  const updatesAvailable = useHasUpdates();
  const readyVersion = useUpdates((s) => (open && s.state?.ready && s.state.status !== "installing" ? s.state.ready.version : null));
  const [value, setValue] = useState("");
  const run = (fn: () => void) => {
    setApp({ dialog: null });
    setValue("");
    fn();
  };
  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })} title="Comandos" description="Busca una acción o un correo">
      {/* CommandDialog (base-nova) doesn't provide the cmdk root itself */}
      <Command>
      <CommandInput placeholder="Escribe un comando o busca…" value={value} onValueChange={setValue} data-testid="palette-input" />
      <CommandList>
        <CommandEmpty>Sin resultados</CommandEmpty>
        <CommandGroup heading="Ir a">
          <CommandItem onSelect={() => run(() => navigate({ view: "inbox" }))}><Inbox /> Entrada<CommandShortcut>G I</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "starred" }))}><Star /> Destacados<CommandShortcut>G S</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "sent" }))}><Send /> Enviados<CommandShortcut>G T</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "archive" }))}><Archive /> Archivo<CommandShortcut>G A</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "trash" }))}><Trash2 /> Papelera</CommandItem>
          {categories.map((c) => (
            <CommandItem key={c.id} value={`categoria ${c.name}`} onSelect={() => run(() => navigate({ categoryId: c.id }))}>
              <CategoryDot color={c.color as CategoryColor} /> {c.name}
            </CommandItem>
          ))}
          {accounts.map((a) => (
            <CommandItem key={a.id} value={`cuenta ${a.displayName} ${a.email}`} onSelect={() => run(() => navigate({ accountId: a.id, view: "inbox" }))}>
              <Layers /> {a.displayName} <span className="text-muted-foreground">{a.email}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Acciones">
          <CommandItem onSelect={() => run(() => openCompose("new"))}><PenLine /> Escribir correo<CommandShortcut>C</CommandShortcut></CommandItem>
          {targets > 0 && (
            <>
              <CommandItem onSelect={() => run(() => void act("archive"))}><Archive /> {targets > 1 ? `Archivar ${targets} conversaciones` : "Archivar conversación"}<CommandShortcut>E</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("trash"))}><Trash2 /> Eliminar<CommandShortcut>⌫</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("spam"))}><OctagonAlert /> Marcar como spam<CommandShortcut>!</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("markRead"))}><MailOpen /> Marcar como leído<CommandShortcut>⇧I</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("markUnread"))}><Mail /> Marcar como no leído<CommandShortcut>⇧U</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => toggleStar())}><Star /> Destacar o quitar destacado<CommandShortcut>S</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => setApp({ dialog: "categoryPicker", pickerMode: "move" }))}><FolderInput /> Mover a…<CommandShortcut>V</CommandShortcut></CommandItem>
            </>
          )}
          {printable && (
            <>
              <CommandItem data-testid="palette-print" onSelect={() => run(() => printCommand("print"))}><Printer /> Imprimir conversación<CommandShortcut>{isMac ? "⌘P" : "Ctrl+P"}</CommandShortcut></CommandItem>
              <CommandItem data-testid="palette-pdf" onSelect={() => run(() => printCommand("pdf"))}><FileDown /> Exportar como PDF<CommandShortcut>{isMac ? "⇧⌘P" : "Ctrl+Shift+P"}</CommandShortcut></CommandItem>
            </>
          )}
          <CommandItem onSelect={() => run(selectAll)}><CheckCheck /> Seleccionar todo<CommandShortcut>⌘A</CommandShortcut></CommandItem>
          {filter && (
            <CommandItem data-testid="palette-unread-filter" value={filter === "on" ? "show all unread filter off" : "show unread only filter"} onSelect={() => run(toggleUnreadFilter)}>
              <ListFilter /> {filter === "on" ? "Show all" : "Show unread only"}<CommandShortcut>{isMac ? "⌘L" : "Ctrl+L"}</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(undoLast)}><Undo2 /> Deshacer<CommandShortcut>Z</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => setApp({ dialog: "filters" }))}><Sparkles /> Crear filtro con IA</CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                void updateAppearance({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" });
              })
            }
          >
            <Moon className="dark:hidden" />
            <Sun className="hidden dark:block" /> Cambiar tema
          </CommandItem>
          {updatesAvailable && (
            <CommandItem data-testid="palette-check-updates" value="check for updates update" onSelect={() => run(() => void checkForUpdates())}>
              <RefreshCw /> Check for Updates…
            </CommandItem>
          )}
          {readyVersion && (
            <CommandItem data-testid="palette-restart-update" value={`restart to update ${readyVersion}`} onSelect={() => run(() => void installUpdate())}>
              <RotateCw /> Restart to Update
            </CommandItem>
          )}
        </CommandGroup>
        <CommandGroup heading="Ajustes">
          {SETTINGS_TABS.map(({ value, label, icon: Icon }) => (
            <CommandItem key={value} value={`ajustes ${label}`} data-testid={`palette-settings-${value}`} onSelect={() => run(() => setApp({ dialog: "settings", settingsTab: value }))}>
              <Icon /> Ajustes <span aria-hidden>→</span> {label}
              {value === "general" && <CommandShortcut>{isMac ? "⌘," : "Ctrl+,"}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        {targets > 0 && (
          <CommandGroup heading={targets > 1 ? `Añadir ${targets} conversaciones` : "Añadir a categoría"}>
            {categories.map((c) => (
              <CommandItem
                key={c.id}
                value={`añadir a ${c.name}`}
                data-testid={`palette-add-${c.id}`}
                onSelect={() =>
                  run(() => {
                    const t = currentTargets();
                    if ("scope" in t) void addScopeToCategory(c.id, t.scope);
                    else void addToCategory(c.id, t.ids, { source: "picker" });
                  })
                }
              >
                <CategoryDot color={c.color as CategoryColor} /> Añadir a «{c.name}»
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {/* last, so Enter on an exact command/category match wins; always shown */}
        {value.trim() && (
          <CommandGroup heading="Buscar" forceMount>
            <CommandItem forceMount value={`buscar ${value}`} onSelect={() => run(() => setApp({ query: value }))}>
              <Search /> Buscar «{value}» en todas las cuentas
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

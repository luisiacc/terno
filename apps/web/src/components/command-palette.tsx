import type { CategoryColor } from "@unica/core";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@unica/ui/components/command";
import { Archive, Inbox, Layers, Moon, PenLine, Search, Send, Settings2, Sparkles, Star, Sun, Trash2 } from "lucide-react";
import { useState } from "react";
import { act, openCompose } from "~/lib/actions";
import { applyTheme } from "~/lib/boot";
import { client } from "~/rpc/connection";
import { navigate, setApp, useApp } from "~/state/app";

export function CommandPalette() {
  const open = useApp((s) => s.dialog === "palette");
  const categories = useApp((s) => s.categories);
  const accounts = useApp((s) => s.accounts);
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
          <CommandItem onSelect={() => run(() => void act("archive"))}><Archive /> Archivar conversación<CommandShortcut>E</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => setApp({ dialog: "filters" }))}><Sparkles /> Crear filtro con IA</CommandItem>
          <CommandItem onSelect={() => run(() => setApp({ dialog: "settings", settingsTab: "general" }))}><Settings2 /> Ajustes</CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
                applyTheme(next);
                void client.call("settings.update", { theme: next }).then((settings) => setApp({ settings }));
              })
            }
          >
            <Moon className="dark:hidden" />
            <Sun className="hidden dark:block" /> Cambiar tema
          </CommandItem>
        </CommandGroup>
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

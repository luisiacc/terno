import type { CategoryColor } from "@terno/core";
import { t } from "@terno/i18n";
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
import { englishWords as english } from "~/lib/palette-words";
import { navigate, setApp, useApp } from "~/state/app";
import { SETTINGS_TABS } from "./settings/tabs";

export function CommandPalette() {
  const open = useApp((s) => s.dialog === "palette");
  const categories = useApp((s) => s.categories);
  const accounts = useApp((s) => s.accounts);
  // what the actions and "Add to" apply to: all N of a view, the checked threads, else the selected one
  const targets = useApp((s) => (open ? (s.scope ? s.scope.count : s.checked.size ? s.checked.size : s.selectedId !== null ? 1 : 0) : 0));
  // printing takes the conversation the reader shows (one, with no new message in the pane)
  const printable = useApp((s) => open && s.selectedId !== null && !s.scope && s.checked.size < 2 && s.compose === null);
  // the unread filter applies to a mailbox (not "Review")
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
    <CommandDialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })} title={t("palette.title")} description={t("palette.description")}>
      {/* CommandDialog (base-nova) doesn't provide the cmdk root itself */}
      <Command>
      <CommandInput placeholder={t("palette.placeholder")} value={value} onValueChange={setValue} data-testid="palette-input" />
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        <CommandGroup heading={t("palette.group.goTo")}>
          <CommandItem onSelect={() => run(() => navigate({ view: "inbox" }))} keywords={english("view.inbox")}><Inbox /> {t("view.inbox")}<CommandShortcut>G I</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "starred" }))} keywords={english("view.starred")}><Star /> {t("view.starred")}<CommandShortcut>G S</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "sent" }))} keywords={english("view.sent")}><Send /> {t("view.sent")}<CommandShortcut>G T</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "archive" }))} keywords={english("view.archive")}><Archive /> {t("view.archive")}<CommandShortcut>G A</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => navigate({ view: "trash" }))} keywords={english("view.trash")}><Trash2 /> {t("view.trash")}</CommandItem>
          {categories.map((c) => (
            <CommandItem key={c.id} value={`${t("palette.search.category")} ${c.name}`} keywords={english("palette.search.category")} onSelect={() => run(() => navigate({ categoryId: c.id }))}>
              <CategoryDot color={c.color as CategoryColor} /> {c.name}
            </CommandItem>
          ))}
          {accounts.map((a) => (
            <CommandItem key={a.id} value={`${t("palette.search.account")} ${a.displayName} ${a.email}`} keywords={english("palette.search.account")} onSelect={() => run(() => navigate({ accountId: a.id, view: "inbox" }))}>
              <Layers /> {a.displayName} <span className="text-muted-foreground">{a.email}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t("palette.group.actions")}>
          <CommandItem onSelect={() => run(() => openCompose("new"))} keywords={english("palette.compose")}><PenLine /> {t("palette.compose")}<CommandShortcut>C</CommandShortcut></CommandItem>
          {targets > 0 && (
            <>
              <CommandItem onSelect={() => run(() => void act("archive"))} keywords={english("palette.archive", { count: targets })}><Archive /> {t("palette.archive", { count: targets })}<CommandShortcut>E</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("trash"))} keywords={english("palette.trash")}><Trash2 /> {t("palette.trash")}<CommandShortcut>⌫</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("spam"))} keywords={english("palette.spam")}><OctagonAlert /> {t("palette.spam")}<CommandShortcut>!</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("markRead"))} keywords={english("palette.markRead")}><MailOpen /> {t("palette.markRead")}<CommandShortcut>⇧I</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => void act("markUnread"))} keywords={english("palette.markUnread")}><Mail /> {t("palette.markUnread")}<CommandShortcut>⇧U</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => toggleStar())} keywords={english("palette.star")}><Star /> {t("palette.star")}<CommandShortcut>S</CommandShortcut></CommandItem>
              <CommandItem onSelect={() => run(() => setApp({ dialog: "categoryPicker", pickerMode: "move" }))} keywords={english("palette.move")}><FolderInput /> {t("palette.move")}<CommandShortcut>V</CommandShortcut></CommandItem>
            </>
          )}
          {printable && (
            <>
              <CommandItem data-testid="palette-print" onSelect={() => run(() => printCommand("print"))} keywords={english("palette.print")}><Printer /> {t("palette.print")}<CommandShortcut>{isMac ? "⌘P" : "Ctrl+P"}</CommandShortcut></CommandItem>
              <CommandItem data-testid="palette-pdf" onSelect={() => run(() => printCommand("pdf"))} keywords={english("palette.exportPdf")}><FileDown /> {t("palette.exportPdf")}<CommandShortcut>{isMac ? "⇧⌘P" : "Ctrl+Shift+P"}</CommandShortcut></CommandItem>
            </>
          )}
          <CommandItem onSelect={() => run(selectAll)} keywords={english("palette.selectAll")}><CheckCheck /> {t("palette.selectAll")}<CommandShortcut>⌘A</CommandShortcut></CommandItem>
          {filter && (
            <CommandItem data-testid="palette-unread-filter" value={`${t(filter === "on" ? "palette.showAll" : "palette.showUnread")} ${t("palette.search.unreadFilter")}`} keywords={[...english(filter === "on" ? "palette.showAll" : "palette.showUnread"), ...english("palette.search.unreadFilter")]} onSelect={() => run(toggleUnreadFilter)}>
              <ListFilter /> {t(filter === "on" ? "palette.showAll" : "palette.showUnread")}<CommandShortcut>{isMac ? "⌘L" : "Ctrl+L"}</CommandShortcut>
            </CommandItem>
          )}
          <CommandItem onSelect={() => run(undoLast)} keywords={english("common.undo")}><Undo2 /> {t("common.undo")}<CommandShortcut>Z</CommandShortcut></CommandItem>
          <CommandItem onSelect={() => run(() => setApp({ dialog: "filters" }))} keywords={english("palette.aiFilter")}><Sparkles /> {t("palette.aiFilter")}</CommandItem>
          <CommandItem
            keywords={english("palette.theme")}
            onSelect={() =>
              run(() => {
                void updateAppearance({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" });
              })
            }
          >
            <Moon className="dark:hidden" />
            <Sun className="hidden dark:block" /> {t("palette.theme")}
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
        <CommandGroup heading={t("common.settings")}>
          {SETTINGS_TABS.map(({ value, label, icon: Icon }) => (
            <CommandItem key={value} value={`${t("common.settings")} ${label}`} keywords={english("common.settings")} data-testid={`palette-settings-${value}`} onSelect={() => run(() => setApp({ dialog: "settings", settingsTab: value }))}>
              <Icon /> {t("common.settings")} <span aria-hidden>→</span> {label}
              {value === "general" && <CommandShortcut>{isMac ? "⌘," : "Ctrl+,"}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        {targets > 0 && (
          <CommandGroup heading={t("palette.group.addTo", { count: targets })}>
            {categories.map((c) => (
              <CommandItem
                key={c.id}
                value={`${t("palette.search.addTo")} ${c.name}`}
                keywords={english("palette.search.addTo")}
                data-testid={`palette-add-${c.id}`}
                onSelect={() =>
                  run(() => {
                    const target = currentTargets();
                    if ("scope" in target) void addScopeToCategory(c.id, target.scope);
                    else void addToCategory(c.id, target.ids, { source: "picker" });
                  })
                }
              >
                <CategoryDot color={c.color as CategoryColor} /> {t("palette.addTo", { name: c.name })}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {/* last, so Enter on an exact command/category match wins; always shown */}
        {value.trim() && (
          <CommandGroup heading={t("common.search")} forceMount>
            <CommandItem forceMount value={`${t("common.search")} ${value}`} onSelect={() => run(() => setApp({ query: value }))}>
              <Search /> {t("palette.searchAll", { query: value })}
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

import { DEFAULT_BINDINGS, type Command } from "@terno/core";
import type { ParamsArg, TextKey } from "@terno/i18n";

/** A catalog key t() renders with no parameters. */
type Label = { [K in TextKey]: ParamsArg<K> extends [] ? K : never }[TextKey];

/** Every command the help lists, by section; each row shows all of its keys. Titles and labels are catalog keys (t() at render). */
export const SECTIONS: { title: Label; rows: [Command, Label][] }[] = [
  {
    title: "shortcuts.section.navigate",
    rows: [
      ["list.next", "shortcuts.next"],
      ["list.prev", "shortcuts.prev"],
      ["list.open", "common.open"],
      ["search.focus", "common.search"],
      ["list.toggleUnread", "shortcuts.unreadOnly"],
      ["palette.open", "shortcuts.palette"],
      ["help.shortcuts", "shortcuts.title"],
      ["settings.open", "common.settings"],
      ["snackbar.focus", "shortcuts.focusSnack"],
      ["go.inbox", "shortcuts.goInbox"],
      ["go.starred", "shortcuts.goStarred"],
      ["go.sent", "shortcuts.goSent"],
      ["go.archive", "shortcuts.goArchive"],
      ["go.trash", "shortcuts.goTrash"],
    ],
  },
  {
    title: "shortcuts.section.select",
    rows: [
      ["list.toggleSelect", "shortcuts.toggleSelect"],
      ["list.selectAll", "shortcuts.selectAll"],
      ["list.extendNext", "shortcuts.extendNext"],
      ["list.extendPrev", "shortcuts.extendPrev"],
      ["list.selectRead", "shortcuts.selectRead"],
      ["list.selectUnread", "shortcuts.selectUnread"],
      ["list.selectStarred", "shortcuts.selectStarred"],
      ["list.selectNone", "shortcuts.selectNone"],
      ["reader.close", "shortcuts.deselect"],
      ["list.menu", "shortcuts.menu"],
    ],
  },
  {
    title: "shortcuts.section.actions",
    rows: [
      ["thread.archive", "shortcuts.archive"],
      ["thread.trash", "shortcuts.trash"],
      ["thread.spam", "shortcuts.spam"],
      ["thread.markRead", "shortcuts.markRead"],
      ["thread.markUnread", "shortcuts.markUnread"],
      ["thread.toggleRead", "shortcuts.toggleRead"],
      ["thread.star", "shortcuts.star"],
      ["thread.category", "shortcuts.categories"],
      ["thread.move", "shortcuts.move"],
      ["action.undo", "common.undo"],
      ["thread.print", "shortcuts.print"],
      ["thread.exportPdf", "shortcuts.exportPdf"],
    ],
  },
  {
    title: "shortcuts.section.compose",
    rows: [
      ["compose.new", "shortcuts.compose"],
      ["compose.reply", "shortcuts.reply"],
      ["compose.replyAll", "shortcuts.replyAll"],
      ["compose.forward", "shortcuts.forward"],
      ["compose.send", "common.send"],
    ],
  },
];

/** Bindings that exist but the dialog doesn't list (the snackbar's own keys are shown on it). */
export const UNLISTED: ReadonlySet<Command> = new Set<Command>(["snackbar.action1", "snackbar.action2", "snackbar.action3", "snackbar.action4", "snackbar.action5", "snackbar.undo", "snackbar.close", "suggestion.accept", "suggestion.reject"]);

/** Every bound command is either listed or deliberately not. */
export const LISTED: ReadonlySet<Command> = new Set(SECTIONS.flatMap((s) => s.rows.map(([c]) => c)));
export const unlistedBindings = () => DEFAULT_BINDINGS.filter((b) => !LISTED.has(b.command) && !UNLISTED.has(b.command)).map((b) => b.command);

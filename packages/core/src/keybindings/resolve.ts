export type Command =
  | "list.next"
  | "list.prev"
  | "list.open"
  | "list.toggleSelect"
  | "list.selectAll"
  | "list.selectNone"
  | "list.selectRead"
  | "list.selectUnread"
  | "list.selectStarred"
  | "list.extendNext"
  | "list.extendPrev"
  | "list.menu"
  | "list.toggleUnread"
  | "reader.close"
  | "nav.back"
  | "nav.forward"
  | "thread.archive"
  | "thread.trash"
  | "thread.spam"
  | "thread.star"
  | "thread.markRead"
  | "thread.markUnread"
  | "thread.toggleRead"
  | "thread.move"
  | "action.undo"
  | "thread.category"
  | "thread.print"
  | "thread.exportPdf"
  | "compose.new"
  | "compose.reply"
  | "compose.replyAll"
  | "compose.forward"
  | "compose.send"
  | "search.focus"
  | "palette.open"
  | "go.inbox"
  | "go.starred"
  | "go.sent"
  | "go.archive"
  | "go.trash"
  | "help.shortcuts"
  | "settings.open"
  | "snackbar.action1"
  | "snackbar.action2"
  | "snackbar.action3"
  | "snackbar.action4"
  | "snackbar.action5"
  | "snackbar.undo"
  | "snackbar.close"
  | "snackbar.focus"
  | "suggestion.accept"
  | "suggestion.reject";

export interface KeyContext {
  /** focus is in an input/textarea/contenteditable */
  editable: boolean;
  composing: boolean;
  dialogOpen: boolean;
  /** the categorization snackbar is up: its keys win */
  snackbar?: boolean;
}

export interface KeyInput {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

interface Binding {
  /** space-separated chord sequence, e.g. "g i", "mod+k", "#" */
  keys: string;
  command: Command;
  /** allowed while typing in an editable field */
  inEditable?: boolean;
  /** allowed while a dialog (palette, compose) is open */
  inDialog?: boolean;
  /** only while this surface is up, and then before global bindings of the same key */
  context?: "snackbar";
}

export const DEFAULT_BINDINGS: readonly Binding[] = [
  { keys: "j", command: "list.next" },
  { keys: "arrowdown", command: "list.next" },
  { keys: "k", command: "list.prev" },
  { keys: "arrowup", command: "list.prev" },
  { keys: "enter", command: "list.open" },
  { keys: "o", command: "list.open" },
  { keys: "x", command: "list.toggleSelect" },
  // selection: ⌘A (Ctrl+A off Mac) and Gmail's "*" sequences act on the loaded rows
  { keys: "mod+a", command: "list.selectAll" },
  { keys: "* a", command: "list.selectAll" },
  { keys: "* n", command: "list.selectNone" },
  { keys: "* r", command: "list.selectRead" },
  { keys: "* u", command: "list.selectUnread" },
  { keys: "* s", command: "list.selectStarred" },
  { keys: "shift+j", command: "list.extendNext" },
  { keys: "shift+arrowdown", command: "list.extendNext" },
  { keys: "shift+k", command: "list.extendPrev" },
  { keys: "shift+arrowup", command: "list.extendPrev" },
  { keys: "shift+f10", command: "list.menu" },
  { keys: "contextmenu", command: "list.menu" },
  // Apple Mail's message filter; resolves everywhere (else the browser's ⌘L takes the address bar), the handler decides
  { keys: "mod+l", command: "list.toggleUnread", inEditable: true, inDialog: true },
  { keys: "escape", command: "reader.close" },
  // plan 24: the List layout's Back and Forward (the browser's and the desktop menu's too); nothing in Split
  { keys: "mod+[", command: "nav.back" },
  { keys: "mod+]", command: "nav.forward" },
  { keys: "e", command: "thread.archive" },
  // Apple Mail's archive
  { keys: "mod+ctrl+a", command: "thread.archive" },
  { keys: "backspace", command: "thread.trash" },
  { keys: "#", command: "thread.trash" },
  { keys: "delete", command: "thread.trash" },
  { keys: "mod+backspace", command: "thread.trash" },
  { keys: "!", command: "thread.spam" },
  { keys: "mod+shift+j", command: "thread.spam" },
  { keys: "s", command: "thread.star" },
  { keys: "mod+shift+l", command: "thread.star" },
  { keys: "shift+i", command: "thread.markRead" },
  { keys: "u", command: "thread.markUnread" },
  { keys: "shift+u", command: "thread.markUnread" },
  { keys: "mod+shift+u", command: "thread.toggleRead" },
  { keys: "l", command: "thread.category" },
  { keys: "v", command: "thread.move" },
  { keys: "z", command: "action.undo" },
  { keys: "mod+z", command: "action.undo" },
  { keys: "c", command: "compose.new" },
  { keys: "r", command: "compose.reply" },
  { keys: "a", command: "compose.replyAll" },
  { keys: "f", command: "compose.forward" },
  { keys: "mod+enter", command: "compose.send", inEditable: true, inDialog: true },
  { keys: "/", command: "search.focus" },
  { keys: "mod+k", command: "palette.open", inEditable: true, inDialog: true },
  { keys: "g i", command: "go.inbox" },
  { keys: "g s", command: "go.starred" },
  { keys: "g t", command: "go.sent" },
  { keys: "g a", command: "go.archive" },
  { keys: "g #", command: "go.trash" },
  { keys: "?", command: "help.shortcuts" },
  // the platform's Settings shortcut: from anywhere, also while typing or writing a draft (a chord types nothing)
  { keys: "mod+,", command: "settings.open", inEditable: true, inDialog: true },
  // the platform's print chords resolve everywhere (else the browser prints the app's own window); the dispatcher decides if they apply
  { keys: "mod+p", command: "thread.print", inEditable: true, inDialog: true },
  { keys: "mod+shift+p", command: "thread.exportPdf", inEditable: true, inDialog: true },
  { keys: "y", command: "suggestion.accept" },
  { keys: "n", command: "suggestion.reject" },
  { keys: "1", command: "snackbar.action1", context: "snackbar" },
  { keys: "2", command: "snackbar.action2", context: "snackbar" },
  { keys: "3", command: "snackbar.action3", context: "snackbar" },
  { keys: "4", command: "snackbar.action4", context: "snackbar" },
  { keys: "5", command: "snackbar.action5", context: "snackbar" },
  { keys: "z", command: "snackbar.undo", context: "snackbar" },
  { keys: "escape", command: "snackbar.close", context: "snackbar" },
  // the docked snackbar never takes focus: F6 goes to it, from the list or while typing (the handler skips it under a dialog)
  { keys: "f6", command: "snackbar.focus", inEditable: true, inDialog: true },
];

/** Canonical chord string for a key event: "mod+shift+k", "#", "arrowdown". */
export function chordOf(input: KeyInput, isMac = true): string {
  const key = input.key.toLowerCase();
  const mods: string[] = [];
  if (isMac ? input.meta : input.ctrl) mods.push("mod");
  // The platform's other modifier must not be silently dropped (ctrl+k on mac is not "k").
  if (isMac ? input.ctrl : input.meta) mods.push(isMac ? "ctrl" : "meta");
  if (input.alt) mods.push("alt");
  // Shift is implied for printable symbols like '#', '!' and '?'; only keep it for letters/named keys.
  const printableSymbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (input.shift && !printableSymbol) mods.push("shift");
  return [...mods, key].join("+");
}

export interface ResolveResult {
  command: Command | null;
  /** the resolver is waiting for the next key of a sequence ("g …") */
  pending: string | null;
}

export function resolveKey(
  input: KeyInput,
  context: KeyContext,
  pending: string | null,
  bindings: readonly Binding[] = DEFAULT_BINDINGS,
  isMac = true,
): ResolveResult {
  const chord = chordOf(input, isMac);
  const sequence = pending ? `${pending} ${chord}` : chord;
  const eligible = bindings.filter(
    (b) =>
      (b.context === undefined || (b.context === "snackbar" && context.snackbar === true)) &&
      (!context.editable || b.inEditable) &&
      (!(context.dialogOpen || context.composing) || b.inDialog),
  );
  const exact = eligible.find((b) => b.context !== undefined && b.keys === sequence) ?? eligible.find((b) => b.keys === sequence);
  if (exact) return { command: exact.command, pending: null };
  if (eligible.some((b) => b.keys.startsWith(`${sequence} `))) return { command: null, pending: sequence };
  // A failed sequence restarts from the current key alone ("g x" → try "x").
  if (pending) return resolveKey(input, context, null, bindings, isMac);
  return { command: null, pending: null };
}

export function shortcutFor(command: Command, bindings: readonly Binding[] = DEFAULT_BINDINGS): string | null {
  return bindings.find((b) => b.command === command)?.keys ?? null;
}

/** Every binding of a command, in table order ("#", "backspace", …): the help dialog lists them all. */
export function shortcutsFor(command: Command, bindings: readonly Binding[] = DEFAULT_BINDINGS, isMac = true): string[] {
  // Apple-only chords (⌃⌘) don't exist elsewhere: off Mac "mod" is Ctrl, so "mod+ctrl" can't be typed
  return bindings.filter((b) => b.command === command && b.context === undefined && (isMac || !b.keys.includes("mod+ctrl"))).map((b) => b.keys);
}

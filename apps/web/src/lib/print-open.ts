/**
 * Opening the print sheet: the only print code in the startup bundle (the
 * sheet and the document builder load when it opens). Every way in (⌘P, the
 * Archivo menu, the toolbar, the palette, a menu) ends here, under one set of
 * rules.
 */
import { chordOf } from "@terno/core";
import { isMac } from "~/lib/select";
import { getApp, setApp } from "~/state/app";

export type PrintIntent = "print" | "pdf";

/** What a sheet prints, fixed when it opens: the thread, and the message it was opened on (if any). */
export interface PrintTarget {
  threadId: number;
  messageId: number | null;
  intent: PrintIntent;
}

/** The thread the reader shows, if a print may start now: no dialog or menu up, no new message in the pane, no bulk selection, not inert. */
export function printableThread(): number | null {
  const s = getApp();
  if (document.getElementById("root")?.inert) return null;
  if (s.dialog !== null || s.menuOpen || s.compose !== null || s.scope !== null || s.checked.size >= 2) return null;
  return s.selectedId;
}

/** Opens the sheet on an explicit target. Already open: nothing (a key and its menu accelerator can't open it twice). */
export function openPrint(target: PrintTarget): void {
  if (getApp().dialog === "print") return;
  setApp({ dialog: "print", printTarget: target, menuOpen: false });
}

/** ⌘P / ⇧⌘P, Archivo, the toolbar and the palette: the open thread, when printing applies. */
export function printCommand(intent: PrintIntent): void {
  const threadId = printableThread();
  if (threadId !== null) openPrint({ threadId, messageId: null, intent });
}

/**
 * Keys pressed inside a mail's frame never reach the document's handler: the
 * print chords are passed on (else the browser prints the frame alone).
 */
export function forwardPrintKey(e: KeyboardEvent): void {
  const chord = chordOf({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }, isMac);
  if (chord !== "mod+p" && chord !== "mod+shift+p") return;
  e.preventDefault();
  printCommand(chord === "mod+p" ? "print" : "pdf");
}

/**
 * A right-click in a message opens its menu (Imprimir este mensaje…). On the
 * web the browser's own menu stays for selected text, links and images (copy,
 * open); the desktop app has no other menu there.
 */
export function wantsNativeMenu(target: EventTarget | null, selection: string): boolean {
  if (window.ternoDesktop) return false;
  return selection.trim() !== "" || Boolean((target as Element | null)?.closest?.("a[href], img, input, textarea, [contenteditable=true]"));
}

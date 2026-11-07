import { matchParts, rowMatchOf, type MatchNeedle, type MessageDetail, type RowMatch } from "@terno/core";
import { create } from "zustand";
import { searchOfKey, useList } from "~/state/list";
import { topCover } from "./reader-scroll";

/**
 * Plan 158: a search's words in the open conversation. Marked where the mail is drawn (React's marks in a plain-text body,
 * DOM marks in an HTML body's frame: never in its source), and stepped through by the reader. The frame never scrolls
 * inside: the reader scrolls to the mark.
 */

const cached: { query: string; match: RowMatch | null } = { query: "", match: null };

/** What the list's rows answer to (not what's being typed by now): one object per search, null outside one. */
export function useSearchMarks(): RowMatch | null {
  const query = useList((s) => searchOfKey(s.itemsKey));
  if (query !== cached.query) {
    cached.query = query;
    cached.match = query ? rowMatchOf(query) : null;
  }
  return cached.match;
}

/** Bumped whenever marks change somewhere in the reader: the reader counts them again. */
export const useReaderMarks = create<{ version: number }>(() => ({ version: 0 }));
export const marksChanged = (): void => useReaderMarks.setState((s) => ({ version: s.version + 1 }));

const MARK_SELECTOR = "mark[data-reader-match]";
/** A mail is marked once it's loaded, on the main thread: bounded, however long the mail is or however one text node runs. */
const MAX_CHARS = 400_000;
const MAX_MARKS = 300;
/** The most an HTML mail's frame shows (it clips past it, and never scrolls inside). */
export const FRAME_MAX_HEIGHT = 20_000;

function unmark(root: HTMLElement): void {
  const parents = new Set<Node>();
  for (const mark of root.querySelectorAll(MARK_SELECTOR)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(root.ownerDocument.createTextNode(mark.textContent ?? ""), mark);
    parents.add(parent);
  }
  for (const parent of parents) parent.normalize();
}

/** Marks the needles in a loaded mail's text, the old marks gone first. Text split across elements isn't found. */
export function markDocument(root: HTMLElement, needles: readonly MatchNeedle[] | undefined): void {
  unmark(root);
  if (!needles?.length) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: { node: Text; parts: NonNullable<ReturnType<typeof matchParts>>; rest: string }[] = [];
  let chars = 0;
  let marks = 0;
  for (let n = walker.nextNode() as Text | null; n && chars < MAX_CHARS && marks < MAX_MARKS; n = walker.nextNode() as Text | null) {
    const read = n.data.slice(0, MAX_CHARS - chars);
    chars += read.length;
    const parts = matchParts(read, needles);
    if (parts) hits.push({ node: n, parts, rest: n.data.slice(read.length) });
    if (parts) marks += parts.reduce((sum, p) => sum + (p.hit ? 1 : 0), 0);
  }
  let left = MAX_MARKS;
  for (const { node, parts, rest } of hits) {
    const out = doc.createDocumentFragment();
    for (const p of parts) {
      if (!p.hit || left <= 0) {
        out.append(p.text);
        continue;
      }
      left--;
      const mark = doc.createElement("mark");
      mark.dataset.readerMatch = "";
      mark.textContent = p.text;
      out.append(mark);
    }
    if (rest) out.append(rest);
    node.replaceWith(out);
  }
}

/** An HTML mail's text as it reads (&#233; is é), bounded. A parsed document runs nothing and loads nothing. */
function textOfHtml(html: string): string {
  // a block ends a word, as it does when drawn: <div>Hola</div><div>pago</div> isn't "Holapago"
  const spaced = html.slice(0, MAX_CHARS).replace(/<\/?(?:br|p|div|li|tr|td|th|h[1-6]|table|ul|ol|blockquote|section|article|hr)\b[^>]*>/gi, "$& ");
  const doc = new DOMParser().parseFromString(spaced, "text/html");
  for (const el of doc.querySelectorAll("style, script, title")) el.remove();
  return doc.body?.textContent ?? "";
}

/** Does this HTML's text hold a match? (A look before anything's drawn.) */
export const htmlHolds = (html: string, needles: readonly MatchNeedle[]): boolean => matchParts(textOfHtml(html), needles) !== null;
export const textHolds = (text: string, needles: readonly MatchNeedle[]): boolean => matchParts(text.slice(0, MAX_CHARS), needles) !== null;

/** The first of these messages whose body holds a match (it opens if it was folded): read in order, and no more than the budget in all. */
export function firstHolding<M extends Pick<MessageDetail, "bodyHtml" | "bodyText">>(messages: readonly M[], needles: readonly MatchNeedle[]): M | undefined {
  let left = MAX_CHARS;
  for (const m of messages) {
    const body = m.bodyHtml ?? m.bodyText;
    if (body === null || left <= 0) continue;
    const read = body.slice(0, left);
    left -= read.length;
    if (m.bodyHtml ? htmlHolds(read, needles) : textHolds(read, needles)) return m;
  }
  return undefined;
}

/** The reader's marks in reading order: plain text and frames as they come. What isn't drawn (hidden in the mail, past its clip) doesn't count. */
export function readerMarks(column: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const el of column.querySelectorAll<HTMLElement>(`${MARK_SELECTOR}, iframe`)) {
    if (!(el instanceof HTMLIFrameElement)) found.push(el);
    // past the frame's clip nothing can be shown: "Show full message" is the way there
    else found.push(...[...(el.contentDocument?.querySelectorAll<HTMLElement>(MARK_SELECTOR) ?? [])].filter((m) => m.getBoundingClientRect().top < FRAME_MAX_HEIGHT));
  }
  return found.filter((m) => m.getClientRects().length > 0);
}

/** The reader scrolled so the mark shows, a third of the way down; nothing moves if it's in view already. The frame itself never scrolls. */
export function revealMark(scroller: HTMLElement, mark: HTMLElement, bottomInset: number): void {
  const frame = mark.ownerDocument.defaultView?.frameElement ?? null;
  const offset = frame ? frame.getBoundingClientRect().top : 0;
  const rect = mark.getBoundingClientRect();
  const top = rect.top + offset;
  const box = scroller.getBoundingClientRect();
  if (top >= box.top + 8 + topCover(scroller) && top + rect.height <= box.bottom - bottomInset - 8) return;
  scroller.scrollTop += top - box.top - scroller.clientHeight / 3;
}

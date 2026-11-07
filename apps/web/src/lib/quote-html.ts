/**
 * Quoted history in HTML mail, for what leaves it out: printing and copying a
 * conversation as text, and the reader, which folds it (`quote.ts` is the plain-text half).
 */
import { ATTRIBUTION } from "~/lib/quote";

/** The line above a forward in Apple Mail, outside the quote it introduces. */
const FORWARDED = /^(begin forwarded message|inicio del mensaje reenviado|mensaje reenviado)\b.*:?$/i;
const says = (n: Node) => (n.nodeType === 3 ? Boolean(n.nodeValue!.trim()) : (n as Element).tagName === "IMG");

/**
 * How far back the line ending at `leaves[end]` goes: "On Monday, Ana <ana@x> wrote:" is three pieces when the address
 * is a link. Back to its block's start or a `<br>`, and never so far that it must be the reply talking (an attribution is short).
 */
function lineStart(leaves: { node: Node }[], end: number): number {
  const blockOf = (n: Node) => n.parentElement?.closest("div, p, li, td, blockquote, body");
  const block = blockOf(leaves[end]!.node);
  if (!block) return end;
  const breaks = [...block.querySelectorAll("br")];
  let start = end;
  let length = leaves[end]!.node.textContent!.length;
  while (start > 0) {
    const before = leaves[start - 1]!.node;
    const after = leaves[start]!.node;
    length += before.textContent!.length;
    // its own block only: a block inside this one is a line of its own
    if (blockOf(before) !== block || length > 200) break;
    if (breaks.some((br) => before.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING && after.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_PRECEDING)) break;
    start--;
  }
  return start;
}

/** Removes a node and everything after it in document order, up to the root. */
function removeFrom(node: Node, root: Node) {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) while (n.nextSibling) n.nextSibling.remove();
  node.parentNode?.removeChild(node);
}

/**
 * Trailing only: Outlook's marker and everything after it, or the last
 * Gmail/Apple Mail quote with its "… wrote:" line when nothing of the reply
 * comes after it. Quotes above the reply's last words make it an inline reply,
 * kept whole; so is a mail with nothing else to say, a bare forward: its
 * history is all of it. A plain `<blockquote>` (what Terno itself sends, its
 * own composer's too) counts only under an attribution line: alone it's a quote
 * the sender chose to write. Says whether it removed anything.
 */
export function stripTrailingQuote(root: Element | DocumentFragment): boolean {
  const outlook = root.querySelector("#appendonsend, #divRplyFwdMsg");
  if (outlook) {
    const walker = root.ownerDocument!.createTreeWalker(root, 0x5 /* elements and text */);
    let said = false;
    for (let n = walker.nextNode(); n && n !== outlook && !said; n = walker.nextNode()) said = says(n);
    if (!said) return false;
    const prev = outlook.previousElementSibling;
    if (prev?.tagName === "HR") prev.remove();
    removeFrom(outlook, root);
    return true;
  }
  const all = [...root.querySelectorAll(".gmail_quote_container, .gmail_quote, blockquote")].filter((el) => el.matches(".gmail_quote_container, .gmail_quote, [type=cite]") || ATTRIBUTION.test(el.previousElementSibling?.textContent?.trim() ?? ""));
  const quotes = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  if (!quotes.length) return false;
  // what the mail says, in order, and the quote each piece is in
  const leaves: { node: Node; quote: Element | null }[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, 0x5 /* elements and text */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (says(n)) leaves.push({ node: n, quote: quotes.find((q) => q.contains(n)) ?? null });
  }
  let i = leaves.length - 1;
  while (i >= 0 && leaves[i]!.quote) i--;
  const trailing = new Set(leaves.slice(i + 1).map((l) => l.quote!));
  if (!trailing.size || leaves.slice(0, i + 1).some((l) => l.quote)) return false;
  const last = leaves[i]?.node;
  const attributed = last?.nodeType === 3 && ATTRIBUTION.test(last.nodeValue!.trim());
  const lead = attributed || (last?.nodeType === 3 && FORWARDED.test(last.nodeValue!.trim()));
  const start = attributed ? lineStart(leaves, i) : i;
  // nothing but its introduction: the history is all this mail has
  if (i < 0 || (lead && start === 0)) return false;
  if (lead) {
    const line = leaves.slice(start, i + 1).map((l) => l.node);
    const words = line.map((n) => n.textContent).join("").trim();
    const block = last!.parentElement?.closest("div, p, li, td, blockquote");
    // the attribution's own line goes, never the reply sharing its block
    if (block && root.contains(block) && block.textContent!.trim() === words) block.remove();
    else for (const n of line) n.parentNode!.removeChild(n);
  }
  for (const q of trailing) q.remove();
  return true;
}

/** Sanitized mail HTML without its trailing history, or null when it has none to fold (most mail: answered without parsing). */
export function withoutTrailingQuote(html: string): string | null {
  if (!/gmail_quote|blockquote|appendonsend|divRplyFwdMsg/i.test(html)) return null;
  const { body } = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  return stripTrailingQuote(body) ? body.innerHTML : null;
}

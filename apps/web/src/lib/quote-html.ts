/**
 * Quoted history in HTML mail, for what leaves it out: printing and copying a
 * conversation as text. Both are lazy chunks; the startup bundle never loads
 * this (`quote.ts`, the plain-text half, the reader uses).
 */
import { ATTRIBUTION } from "~/lib/quote";

/** Removes a node and everything after it in document order, up to the root. */
function removeFrom(node: Node, root: Node) {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) while (n.nextSibling) n.nextSibling.remove();
  node.parentNode?.removeChild(node);
}

/**
 * Trailing only: Outlook's marker and everything after it, or the last
 * Gmail/Apple Mail quote with its "… wrote:" line when nothing of the reply
 * comes after it. Quotes above the reply's last words make it an inline reply,
 * kept whole.
 */
export function stripTrailingQuote(root: Element | DocumentFragment) {
  const outlook = root.querySelector("#appendonsend, #divRplyFwdMsg");
  if (outlook) {
    const prev = outlook.previousElementSibling;
    if (prev?.tagName === "HR") prev.remove();
    removeFrom(outlook, root);
    return;
  }
  const all = [...root.querySelectorAll(".gmail_quote_container, .gmail_quote, blockquote[type=cite]")];
  const quotes = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  if (!quotes.length) return;
  // what the mail says, in order, and the quote each piece is in
  const leaves: { node: Node; quote: Element | null }[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, 0x5 /* elements and text */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3 ? n.nodeValue!.trim() : (n as Element).tagName === "IMG") leaves.push({ node: n, quote: quotes.find((q) => q.contains(n)) ?? null });
  }
  let i = leaves.length - 1;
  while (i >= 0 && leaves[i]!.quote) i--;
  const trailing = new Set(leaves.slice(i + 1).map((l) => l.quote!));
  if (!trailing.size || leaves.slice(0, i + 1).some((l) => l.quote)) return;
  const last = leaves[i]?.node;
  if (last?.nodeType === 3 && ATTRIBUTION.test(last.nodeValue!.trim())) {
    const block = last.parentElement;
    // the attribution's own line goes, never the reply sharing its block
    if (block && root.contains(block) && block.textContent!.trim() === last.nodeValue!.trim()) block.remove();
    else last.parentNode!.removeChild(last);
  }
  for (const q of trailing) q.remove();
}

import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { AI_GAP } from "../ai-card";

/**
 * Plan 161: the gaps a model left in what it wrote (`[What you think.]`), marked in the composer while they're in the
 * text, so nobody sends one by mistake. Only the strings the draft came with (`checks.placeholders`), never a bracket the
 * user typed; nothing to do, and no work, while there are none.
 */
interface GapState {
  gaps: readonly string[];
  set: DecorationSet;
}

export const gapsKey = new PluginKey<GapState>("ai-gaps");

/** Where each of `gaps` is, in document order: a match ends at a line's end, as `findPlaceholders` does. */
export function findGaps(doc: PMNode, gaps: readonly string[]): { from: number; to: number; text: string }[] {
  const out: { from: number; to: number; text: string }[] = [];
  if (!gaps.length) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => { text += child.isText ? child.text : "\n"; });
    for (const gap of gaps) {
      for (let at = text.indexOf(gap); at >= 0; at = text.indexOf(gap, at + gap.length)) out.push({ from: pos + 1 + at, to: pos + 1 + at + gap.length, text: gap });
    }
    return false;
  });
  return out.sort((a, b) => a.from - b.from);
}

function decorate(doc: PMNode, gaps: readonly string[]): DecorationSet {
  const found = findGaps(doc, gaps);
  if (!found.length) return DecorationSet.empty;
  return DecorationSet.create(doc, found.map((g) => Decoration.inline(g.from, g.to, { class: AI_GAP, "data-testid": "compose-gap" })));
}

/** The gaps to mark from now on: with the transaction that writes them. */
export const withGaps = (tr: Transaction, gaps: readonly string[]): Transaction => tr.setMeta(gapsKey, [...new Set(gaps.filter(Boolean))]);

export const gapsPlugin = new Plugin<GapState>({
  key: gapsKey,
  state: {
    init: () => ({ gaps: [], set: DecorationSet.empty }),
    apply(tr, prev) {
      const gaps = (tr.getMeta(gapsKey) as string[] | undefined) ?? prev.gaps;
      if (!gaps.length) return prev.gaps.length ? { gaps, set: DecorationSet.empty } : prev;
      if (gaps === prev.gaps && !tr.docChanged) return prev;
      return { gaps, set: decorate(tr.doc, gaps) };
    },
  },
  props: { decorations: (state: EditorState) => gapsKey.getState(state)?.set },
});

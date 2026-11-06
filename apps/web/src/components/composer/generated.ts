import { fromPlainText, schema } from "@terno/richtext";
import { closeHistory } from "prosemirror-history";
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { isEmpty } from "./editor";

/**
 * Plan 133 §10.1: model text into the document, as the composer's part of committing a draft: one transaction,
 * one undo step of its own. Plain text only: a line is a paragraph, as a person's typing makes it, and it never goes
 * through a snippet's `fillText`, so a literal `{first_name}` stays literal.
 */

/** Where a placeholder's text is, searching forward from `from`; line breaks and images end a match. */
function findText(doc: PMNode, needle: string, from: number): { from: number; to: number } | null {
  if (!needle) return null;
  let found: { from: number; to: number } | null = null;
  doc.nodesBetween(from, doc.content.size, (node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => { text += child.isText ? child.text : "\n"; });
    const start = pos + 1;
    const at = text.indexOf(needle, Math.max(0, from - start));
    if (at >= 0) found = { from: start + at, to: start + at + needle.length };
    return false;
  });
  return found;
}

export function generatedTr(state: EditorState, text: string, how: "replace" | "below", placeholder?: string): Transaction {
  const doc = fromPlainText(text);
  const tr = state.tr;
  let start = 0;
  if (how === "replace" || isEmpty(state.doc)) {
    tr.replaceWith(0, state.doc.content.size, doc.content);
  } else {
    // a blank line after what's there, as a person would leave one
    start = state.doc.content.size;
    tr.insert(start, [schema.nodes.paragraph.create(), ...nodesOf(doc)]);
    start += 2;
  }
  const spot = placeholder ? findText(tr.doc, placeholder, start) : null;
  tr.setSelection(spot ? TextSelection.create(tr.doc, spot.from, spot.to) : TextSelection.atEnd(tr.doc));
  // its own undo step: nothing typed just before joins it
  return closeHistory(tr);
}

function nodesOf(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.forEach((node) => out.push(node));
  return out;
}

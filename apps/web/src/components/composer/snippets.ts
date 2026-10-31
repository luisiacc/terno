import { findVariables, type SnippetValues } from "@terno/core";
import { fromPlainText, parseHtml, schema } from "@terno/richtext";
import { closeHistory } from "prosemirror-history";
import { Slice, type Node as PMNode } from "prosemirror-model";
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Transform } from "prosemirror-transform";
import { isEmpty, serialize } from "./editor";

/**
 * Plan 93: a snippet into the text. Lazy (the composer chunk): the document a
 * snippet is, its variables filled across formatting, and the one transaction
 * (one undo step) that puts it at the caret.
 */

/** A document without its images (they belong to a draft's attachments, never to a snippet). */
export function withoutImages(doc: PMNode): PMNode {
  const at: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.image) at.push(pos);
  });
  if (!at.length) return doc;
  const tr = new Transform(doc);
  for (const pos of at.reverse()) tr.delete(pos, pos + 1);
  return tr.doc;
}

/** A snippet's body as a document: its HTML (through the schema), else its text, without images. */
export function snippetDoc(html: string, text: string): PMNode {
  return withoutImages(html ? parseHtml(html) : fromPlainText(text));
}

/** A textblock's text with the document position of each character (inline nodes that aren't text break a match). */
function blockText(block: PMNode, start: number): { text: string; pos: number[] } {
  let text = "";
  const pos: number[] = [];
  block.forEach((child, offset) => {
    if (child.isText) {
      for (let i = 0; i < child.text!.length; i++) pos.push(start + offset + i);
      text += child.text;
    } else {
      // a line break or an image: a character no variable contains
      pos.push(start + offset);
      text += "\n";
    }
  });
  return { text, pos };
}

/**
 * Fills the variables between `from` and `to` (a `{first_name}` split by
 * formatting is still one), each taking the marks at its start; returns the
 * ranges of those left unfilled, in order.
 */
export function fillVariables(tr: Transform, from: number, to: number, values: SnippetValues): { from: number; to: number }[] {
  const found: { from: number; to: number; value: string | null }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const { text, pos: at } = blockText(node, pos + 1);
    for (const m of findVariables(text, values)) {
      const a = at[m.from]!;
      const b = at[m.to - 1]! + 1;
      if (a >= from && b <= to) found.push({ from: a, to: b, value: m.value });
    }
    return false;
  });
  const startMaps = tr.mapping.maps.length;
  // the last first, so earlier positions hold
  for (const f of [...found].reverse()) {
    if (f.value === null) continue;
    const marks = tr.doc.resolve(f.from + 1).marks();
    tr.replaceWith(f.from, f.to, schema.text(f.value, marks));
  }
  const map = (p: number, assoc: number) => tr.mapping.slice(startMaps).map(p, assoc);
  return found.filter((f) => f.value === null).map((f) => ({ from: map(f.from, 1), to: map(f.to, -1) }));
}

/**
 * The transaction that inserts a snippet at the selection (an empty body is
 * replaced whole), its variables filled; the caret after it, or the first
 * variable that couldn't be filled selected, to type over.
 */
export function insertSnippetTr(state: EditorState, doc: PMNode, values: SnippetValues): Transaction {
  const tr = state.tr;
  let start: number;
  let end: number;
  if (isEmpty(state.doc)) {
    tr.replaceWith(0, state.doc.content.size, doc.content);
    start = 0;
    end = tr.doc.content.size;
  } else {
    const { from, to } = state.selection;
    // open at both ends: a one-line snippet joins the line at the caret
    tr.replaceRange(from, to, Slice.maxOpen(doc.content));
    start = tr.mapping.map(from, -1);
    end = tr.mapping.map(to, 1);
  }
  const before = tr.mapping.maps.length;
  const unfilled = fillVariables(tr, start, end, values);
  end = tr.mapping.slice(before).map(end, 1);
  const first = unfilled[0];
  tr.setSelection(first ? TextSelection.create(tr.doc, first.from, first.to) : TextSelection.near(tr.doc.resolve(end), -1));
  // its own undo step: nothing typed just before joins it
  return closeHistory(tr).scrollIntoView();
}

/** A snippet's body filled in, as a draft carries it (a new message made from it). */
export function filledBody(html: string, text: string, values: SnippetValues): { html: string; text: string } {
  const tr = new Transform(snippetDoc(html, text));
  fillVariables(tr, 0, tr.doc.content.size, values);
  return serialize(tr.doc);
}

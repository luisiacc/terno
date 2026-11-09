import type { Node as PMNode } from "prosemirror-model";

/**
 * Plan 163 (Codex review 5): the body as the editor's own blocks read, for ⌘J to decide what was written and where its
 * gaps are. Not the serialized email: a list's `- `, a quote's `>` and a link's address are never in it, so an offset here
 * is a place in the document. A block is a line; a line break is a line too; an image is `￼`. It stops past `limit`
 * characters, so a glance at a 10 MB draft reads its start and nothing more.
 */
export interface BodyText {
  text: string;
  images: boolean;
  /** read only up to the limit */
  truncated: boolean;
  /** stretches of plain text in one block, between breaks and images: `at` in the text, `pos` in the document */
  runs: readonly { at: number; pos: number; len: number }[];
  /** what's inside a quote: never a gap */
  quoted: readonly { from: number; to: number }[];
}

export function bodyText(doc: PMNode, limit = Infinity): BodyText {
  let text = "";
  let images = false;
  let truncated = false;
  const runs: { at: number; pos: number; len: number }[] = [];
  const quoted: { from: number; to: number }[] = [];
  let quoteDepth = 0;
  let quoteFrom = 0;
  let first = true;
  const walk = (node: PMNode, pos: number): void => {
    if (truncated) return;
    if (node.type.name === "blockquote") {
      if (quoteDepth++ === 0) quoteFrom = text.length;
      node.forEach((child, offset) => walk(child, pos + 1 + offset));
      if (--quoteDepth === 0) quoted.push({ from: quoteFrom, to: text.length });
      return;
    }
    if (!node.isTextblock) {
      node.forEach((child, offset) => walk(child, pos + 1 + offset));
      return;
    }
    if (!first) text += "\n";
    first = false;
    node.forEach((child, offset) => {
      if (truncated) return;
      const at = pos + 1 + offset;
      if (child.isText) {
        const value = child.text ?? "";
        const last = runs[runs.length - 1];
        // marks split text into nodes; a run goes on across them
        if (last && last.at + last.len === text.length && last.pos + last.len === at) last.len += value.length;
        else runs.push({ at: text.length, pos: at, len: value.length });
        text += value;
      } else if (child.type.name === "image") {
        images = true;
        text += "￼";
      } else {
        text += "\n";
      }
      if (text.length > limit) truncated = true;
    });
  };
  doc.forEach((child, offset) => walk(child, offset));
  return { text, images, truncated, runs, quoted };
}

/** A stretch of the text as a document range: only inside one run (never across a break, an image or a block), never in a quote. */
export function docRange(b: BodyText, from: number, to: number): { from: number; to: number } | null {
  if (b.quoted.some((q) => from < q.to && to > q.from)) return null;
  const run = b.runs.find((r) => from >= r.at && to <= r.at + r.len);
  return run ? { from: run.pos + (from - run.at), to: run.pos + (to - run.at) } : null;
}

/** The text offset of a document position inside a run, or null. */
export function textAt(b: BodyText, pos: number): number | null {
  const run = b.runs.find((r) => pos >= r.pos && pos <= r.pos + r.len);
  return run ? run.at + (pos - run.pos) : null;
}

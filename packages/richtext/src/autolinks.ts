import { Fragment, Slice, type Mark, type Node as PMNode } from "prosemirror-model";
import { spelledHref } from "./links";
import { schema } from "./schema";

/**
 * What a sent mail writes for autolinks (plan 39): the href each one's text
 * spells, and plain text for one that spells nothing. The editor keeps them
 * so as the text changes; this makes a stale href impossible in what is sent
 * whatever state a document is in. A textblock without a stale autolink is
 * returned as it is (one pass over its children).
 */
export function spelledLinks(block: PMNode): PMNode {
  const count = block.childCount;
  // runs of children carrying the same autolink
  let fixes: { from: number; to: number; mark: Mark; href: string | null }[] | null = null;
  for (let i = 0; i < count; ) {
    const mark = autoLink(block.child(i));
    if (!mark) {
      i++;
      continue;
    }
    let text = "";
    let j = i;
    for (; j < count && autoLink(block.child(j))?.eq(mark); j++) {
      const child = block.child(j);
      text += child.isText ? child.text! : "￼";
    }
    const href = spelledHref(text);
    if (href !== mark.attrs.href) (fixes ??= []).push({ from: i, to: j, mark, href });
    i = j;
  }
  if (!fixes) return block;
  const children: PMNode[] = [];
  for (let i = 0, f = 0; i < count; i++) {
    const child = block.child(i);
    while (f < fixes.length && fixes[f]!.to <= i) f++;
    const fix = fixes[f];
    if (!fix || i < fix.from) {
      children.push(child);
      continue;
    }
    const marks = fix.mark.removeFromSet(child.marks);
    children.push(child.mark(fix.href ? schema.marks.link.create({ href: fix.href, auto: true }).addToSet(marks) : marks));
  }
  return block.copy(Fragment.fromArray(children));
}

/** A copied slice with spelledLinks on every line in it: a part of "https://santo.com" copied never carries santo.com to another app. */
export function spelledSlice(slice: Slice): Slice {
  const content = spelledFragment(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

function spelledFragment(fragment: Fragment): Fragment {
  // inline content at the top (a slice inside one line): read as one line
  if (fragment.firstChild?.isInline) {
    const line = spelledLinks(schema.nodes.paragraph.create(null, fragment));
    return line.content === fragment ? fragment : line.content;
  }
  let changed = false;
  const children: PMNode[] = [];
  fragment.forEach((node) => {
    let next = node;
    if (node.inlineContent) next = spelledLinks(node);
    else if (!node.isLeaf) {
      const content = spelledFragment(node.content);
      if (content !== node.content) next = node.copy(content);
    }
    if (next !== node) changed = true;
    children.push(next);
  });
  return changed ? Fragment.from(children) : fragment;
}

const autoLink = (node: PMNode): Mark | undefined => node.marks.find((m) => m.type === schema.marks.link && m.attrs.auto === true);

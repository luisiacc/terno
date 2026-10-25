import type { Node as PMNode } from "prosemirror-model";
import { hrefLabel } from "./links";
import { schema } from "./schema";

/**
 * A document as the plain-text alternative of the mail (plan 16 §3), and a
 * plain text as a document (every draft before plan 16). Lines stay as
 * written; lists read "1." and "•", links "text (url)", quotes "> ".
 */

const INDENT = "    ";

/** The inline content of a textblock as text: links as "text (url)" (the URL alone when that is the text). */
function inlineText(block: PMNode): string {
  let out = "";
  let link: { href: string; text: string } | null = null;
  const flush = () => {
    if (!link) return;
    const label = hrefLabel(link.href);
    out += link.text.trim() === "" || link.text === link.href || link.text === label ? link.text || label : `${link.text} (${label})`;
    link = null;
  };
  block.forEach((child) => {
    const href = child.marks.find((m) => m.type === schema.marks.link)?.attrs.href as string | undefined;
    if (link && link.href !== href) flush();
    const text = child.isText ? child.text! : child.type === schema.nodes.hard_break ? "\n" : "";
    if (href) {
      link ??= { href, text: "" };
      link.text += text;
    } else out += text;
  });
  flush();
  return out;
}

/** Lines of a block (prefix applied to every line it produces). */
function blockLines(node: PMNode, prefix: string, out: string[]): void {
  switch (node.type.name) {
    case "paragraph": {
      const indent = INDENT.repeat(node.attrs.indent as number);
      for (const line of inlineText(node).split("\n")) out.push(prefix + indent + line);
      return;
    }
    case "blockquote": {
      // "> " per level; an empty quoted line is ">" (no trailing space), as mail clients write it
      const lines: string[] = [];
      node.forEach((child) => blockLines(child, "", lines));
      for (const l of lines) out.push(`${prefix}${l === "" ? ">" : `> ${l}`}`);
      return;
    }
    case "bullet_list":
    case "ordered_list": {
      let n = node.type.name === "ordered_list" ? (node.attrs.start as number) : 0;
      node.forEach((item) => {
        const marker = node.type.name === "ordered_list" ? `${n++}. ` : "• ";
        const pad = " ".repeat(marker.length);
        const lines: string[] = [];
        item.forEach((child) => blockLines(child, "", lines));
        lines.forEach((l, i) => out.push(prefix + (i === 0 ? marker : pad) + l));
      });
      return;
    }
    default:
      node.forEach((child) => blockLines(child, prefix, out));
  }
}

/** The plain-text alternative of a document. */
export function toPlainText(doc: PMNode): string {
  const out: string[] = [];
  doc.forEach((block) => blockLines(block, "", out));
  return out.join("\n");
}

/** A plain text as a document: one line, one paragraph (CRLF read as LF). toPlainText gives the text back. */
export function fromPlainText(text: string): PMNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return schema.node(
    "doc",
    null,
    lines.map((line) => schema.node("paragraph", null, line ? [schema.text(line)] : [])),
  );
}

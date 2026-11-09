/** A run of an answer: plain text, or a citation with the word it follows and the punctuation after it, which never part. */
export type AnswerRun = { text: string } | { lead: string; cites: number[]; trail: string };

/** what closes a clause: stays with the marker before it, never starts a line */
const TRAIL = /^\s*([.,;:!?…)\]»”"’']+)/;

/**
 * Plan 161: "…look into it [1]. Isabella…" as runs: the space the model put before a marker goes, the marker binds to
 * "it" and to the ".", so a line can't end on the word and start on ". " (or on the marker). Markers side by side share
 * one run.
 */
export function citationRuns(text: string): AnswerRun[] {
  const runs: AnswerRun[] = [];
  for (const part of text.split(/(\s*\[\d+\])/)) {
    if (!part) continue;
    const cite = /^\s*\[(\d+)\]$/.exec(part);
    const last = runs.at(-1);
    if (cite) {
      const n = Number(cite[1]);
      if (last && "cites" in last && !last.trail) {
        last.cites.push(n);
        continue;
      }
      let lead = "";
      if (last && "text" in last && !/\s$/.test(last.text)) {
        lead = /\S+$/.exec(last.text)?.[0] ?? "";
        last.text = last.text.slice(0, last.text.length - lead.length);
        if (!last.text) runs.pop();
      }
      runs.push({ lead, cites: [n], trail: "" });
      continue;
    }
    let rest = part;
    if (last && "cites" in last && !last.trail) {
      const m = TRAIL.exec(rest);
      if (m) {
        last.trail = m[1]!;
        rest = rest.slice(m[0].length);
      }
    }
    if (rest) runs.push({ text: rest });
  }
  return runs;
}

/** An answer's block: a paragraph, or a list of items (each an item's words, its marker taken off). */
export type AnswerBlock = { kind: "p"; text: string } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+/;

/**
 * Plan 162 (after ai162-r04): an answer's lines as blocks. A run of "- " (or "* ", "• ") lines is a list, of "1. " lines
 * a numbered one; anything else is a paragraph, and a blank line ends one. Only that: no other markdown is read.
 */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (const line of text.split("\n")) {
    const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
    if (kind) {
      endPara();
      const item = line.replace(kind === "ul" ? BULLET : NUMBERED, "");
      const last = blocks.at(-1);
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (!line.trim()) endPara();
    else para.push(line);
  }
  endPara();
  return blocks;
}

/** "**words**" as bold, nothing else; a lone "**" is dropped rather than shown. */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  const parts: { text: string; bold: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), bold: false });
    parts.push({ text: m[1]!, bold: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), bold: false });
  return parts.map((p) => ({ ...p, text: p.text.replace(/\*\*/g, "") })).filter((p) => p.text);
}

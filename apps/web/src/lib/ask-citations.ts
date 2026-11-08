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

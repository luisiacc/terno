import { schema } from "@terno/richtext";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { Mapping, Transform } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { AI_FILL, AI_FILL_STREAM } from "../ai-card";

/**
 * Plan 163: the gaps someone left in their own email, filled by the model. While it fills, each gap is a range in this
 * editor's state, mapped through every change (so typing elsewhere goes on), and its fill shows where the placeholder is,
 * as a decoration: nothing touches the document, its history or autosave until the one transaction that fills them all.
 * A gap any change touches is spoiled for good (Codex review 7), even if the same words are typed back. Afterwards each
 * fill keeps a tint until it's edited or the strip goes. Nothing at all happens without a fill.
 */

export interface PendingGap {
  /** from 1, as the request numbered them */
  n: number;
  from: number;
  to: number;
  spoiled: boolean;
  /** the fill so far, and whether it's finished */
  text: string;
  done: boolean;
}

interface FillState {
  /** the run filling now, or null */
  run: string | null;
  gaps: readonly PendingGap[];
  /** what was filled, tinted for review */
  filled: readonly { from: number; to: number }[];
  set: DecorationSet;
}

export const fillsKey = new PluginKey<FillState>("ai-fills");

type Meta =
  | { start: { run: string; gaps: { from: number; to: number }[] } }
  | { stream: { run: string; n: number; text: string; done: boolean } }
  | { stop: string }
  | { filled: { from: number; to: number }[] }
  | { clearFilled: true };

export const withFillMeta = (tr: Transaction, meta: Meta): Transaction => tr.setMeta(fillsKey, meta);

const EMPTY: FillState = { run: null, gaps: [], filled: [], set: DecorationSet.empty };

/** A range through a transaction's steps: `touched` when any step changes what's inside it (an insertion at its edges doesn't). */
function mapRange(mapping: Mapping, from: number, to: number): { from: number; to: number; touched: boolean } {
  let f = from;
  let t = to;
  let touched = false;
  for (const map of mapping.maps) {
    map.forEach((oldStart, oldEnd) => {
      if (oldStart < t && oldEnd > f) touched = true;
      else if (oldStart === oldEnd && oldStart > f && oldStart < t) touched = true;
    });
    f = map.map(f, 1);
    t = map.map(t, -1);
  }
  return { from: f, to: Math.max(f, t), touched };
}

function decorate(doc: PMNode, s: Omit<FillState, "set">): DecorationSet {
  const out: Decoration[] = [];
  for (const g of s.gaps) {
    if (g.spoiled || !g.text) continue;
    // the placeholder hidden, its fill in its place as it comes
    out.push(Decoration.inline(g.from, g.to, { class: "ai-fill-hidden" }));
    out.push(
      Decoration.widget(
        g.from,
        () => {
          const span = document.createElement("span");
          span.className = AI_FILL_STREAM;
          span.dataset.testid = "compose-fill-stream";
          span.textContent = g.text;
          return span;
        },
        { key: `fill-${g.n}-${g.done ? 1 : 0}-${g.text}`, side: -1 },
      ),
    );
  }
  for (const f of s.filled) if (f.to > f.from) out.push(Decoration.inline(f.from, f.to, { class: AI_FILL, "data-testid": "compose-fill" }));
  return out.length ? DecorationSet.create(doc, out) : DecorationSet.empty;
}

export const fillsPlugin = new Plugin<FillState>({
  key: fillsKey,
  state: {
    init: () => EMPTY,
    apply(tr, prev) {
      const meta = tr.getMeta(fillsKey) as Meta | undefined;
      // nothing filling, nothing filled: no work on a keystroke
      if (!meta && prev.run === null && !prev.filled.length) return prev;
      if (!meta && !tr.docChanged) return prev;
      let { run, gaps, filled } = prev;
      if (tr.docChanged) {
        gaps = gaps.map((g) => {
          const m = mapRange(tr.mapping, g.from, g.to);
          return { ...g, from: m.from, to: m.to, spoiled: g.spoiled || m.touched };
        });
        // a fill edited inside is theirs now: its tint goes
        filled = filled.flatMap((f) => {
          const m = mapRange(tr.mapping, f.from, f.to);
          return m.touched || m.to <= m.from ? [] : [{ from: m.from, to: m.to }];
        });
      }
      if (meta && "start" in meta) {
        run = meta.start.run;
        gaps = meta.start.gaps.map((g, i) => ({ n: i + 1, from: g.from, to: g.to, spoiled: false, text: "", done: false }));
      } else if (meta && "stream" in meta && meta.stream.run === run) {
        const { n, text, done } = meta.stream;
        gaps = gaps.map((g) => (g.n === n ? { ...g, text, done } : g));
      } else if (meta && "stop" in meta && meta.stop === run) {
        run = null;
        gaps = [];
      } else if (meta && "filled" in meta) {
        filled = meta.filled;
      } else if (meta && "clearFilled" in meta) {
        filled = [];
      }
      if (run === null && !gaps.length && !filled.length) return EMPTY;
      const next = { run, gaps, filled };
      return { ...next, set: decorate(tr.doc, next) };
    },
  },
  props: { decorations: (state: EditorState) => fillsKey.getState(state)?.set },
});

/** The run filling in this state, and its gaps as they stand. */
export const fillsOf = (state: EditorState): FillState => fillsKey.getState(state) ?? EMPTY;

/**
 * Plan 163: each range of `doc` replaced by its text in `t`, keeping the marks its first character had, last first so the
 * positions hold; and where each fill now is.
 */
export function fillInto<T extends Transform>(t: T, doc: PMNode, fills: readonly { from: number; to: number; text: string }[]): { tr: T; filled: { from: number; to: number }[] } {
  const sorted = [...fills].sort((a, b) => a.from - b.from);
  for (const f of [...sorted].reverse()) t.replaceWith(f.from, f.to, schema.text(f.text, doc.nodeAt(f.from)?.marks ?? []));
  const filled: { from: number; to: number }[] = [];
  let shift = 0;
  for (const f of sorted) {
    const from = f.from + shift;
    filled.push({ from, to: from + f.text.length });
    shift += f.text.length - (f.to - f.from);
  }
  return { tr: t, filled };
}


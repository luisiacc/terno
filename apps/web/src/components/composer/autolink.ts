import { isDelimiter, linkIn, linksIn, MAX_URL_LENGTH, schema, spelledHref } from "@terno/richtext";
import { InputRule } from "prosemirror-inputrules";
import { Fragment, Slice, type Mark, type Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, Selection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { AddMarkStep, Mapping, RemoveMarkStep } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";

/**
 * Autolinks (plan 39). A URL typed (then a space, Enter or ⇧Enter) or pasted
 * becomes a link marked `auto`, and stays live: its href is always the URL
 * its text spells. Edit inside it or type right after it and the link
 * follows; when the text spells no URL any more the link goes. Manual links
 * (the link dialog with other text, a pasted <a> with a label) are never
 * touched. The work is local: a keystroke looks at the children of one line
 * near the caret, never at the document.
 */

const { marks } = schema;

/** Non-text leaves (a line break) read as this in a line's text: a delimiter. */
const LEAF = "￼";
/** How far from a change a token may reach: a longer one spells nothing (linkIn's cap). */
const WINDOW = MAX_URL_LENGTH + 1;

interface Run {
  from: number;
  to: number;
  mark: Mark;
}

/**
 * The link runs of a line that reach into [from, to) (offsets in the line), whole: adjacent children with the same
 * link merged, a run that starts before `from` (its first child formatted apart, say) from where it starts.
 */
function linkRuns(block: PMNode, from: number, to: number): Run[] {
  const runs: Run[] = [];
  let offset = 0;
  for (let i = 0, n = block.childCount; i < n && offset < to; i++) {
    const child = block.child(i);
    const end = offset + child.nodeSize;
    const m = child.marks.find((x) => x.type === marks.link);
    const last = runs[runs.length - 1];
    if (m && last && last.to === offset && last.mark.eq(m)) last.to = end;
    else if (m) {
      // before the window only the run that may reach into it is kept
      if (last && last.to <= from) runs.pop();
      runs.push({ from: offset, to: end, mark: m });
    }
    offset = end;
  }
  return runs.filter((r) => r.to > from);
}

const isAuto = (m: Mark) => m.attrs.auto === true;
const autoLink = (href: string) => marks.link.create({ href, auto: true });

function hasMono(doc: PMNode, from: number, to: number): boolean {
  let mono = false;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type === marks.font && m.attrs.value === "mono")) mono = true;
    return !mono;
  });
  return mono;
}

// ── making a link where the user ends a word

/**
 * The URL just typed before `end` (on a space, Enter or ⇧Enter) becomes an
 * autolink: the token back to a delimiter or a link's edge, at most
 * MAX_URL_LENGTH back. Not in fixed-width text (the composer's code), not
 * over a link.
 */
export function linkTypedUrl(state: EditorState, end: number, tr: Transaction): boolean {
  const $end = state.doc.resolve(end);
  const block = $end.parent;
  if (!block.inlineContent) return false;
  const off = $end.parentOffset;
  const lo = Math.max(0, off - WINDOW);
  const runs = linkRuns(block, lo, off);
  // right after a link: it is already one (an autolink grows by itself)
  if (runs.some((r) => r.to >= off)) return false;
  const floor = runs.reduce((max, r) => Math.max(max, r.to), lo);
  const text = block.textBetween(lo, off, undefined, LEAF);
  // the word before the caret, back to a space or a link; its tokens (split at quotes and angle brackets: "<https://x.com>")
  let s = off;
  while (s > floor && !isSpace(text.charCodeAt(s - 1 - lo))) s--;
  // (a word back to the window's start is longer than any link: linkIn refuses it)
  const found = s === lo && lo > 0 ? [] : linksIn(text.slice(s - lo, off - lo));
  let linked = false;
  for (const f of found) {
    const from = $end.start() + s + f.start;
    const to = $end.start() + s + f.end;
    if (hasMono(state.doc, from, to)) continue;
    tr.addMark(from, to, autoLink(f.href));
    linked = true;
  }
  return linked;
}

/** Whitespace and line breaks: the delimiters that end a word (quotes and angle brackets end only a token). */
const isSpace = (c: number) => isDelimiter(c) && !QUOTES.has(c);
const QUOTES = new Set([0x22, 0x3c, 0x3e, 0xab, 0xbb, 0x2018, 0x2019, 0x201c, 0x201d]);

/** A space (any whitespace) after a URL links it, and types the space outside the link (NBSP as a space, as everywhere in the editor). */
export const autolinkRule = new InputRule(/\s$/, (state, match, start, end) => {
  const tr = state.tr;
  if (!linkTypedUrl(state, start, tr)) return null;
  return tr.insertText(match[0] === " " ? " " : match[0], start, end);
});

/**
 * Enter or ⇧Enter after a typed URL links it and does what the key does, in
 * one transaction (one undo step, as a space's link is): the key's command
 * runs on the state with the link, and its steps follow the link's.
 */
export const withAutolink =
  (enter: Command): Command =>
  (state, dispatch, view) => {
    if (!dispatch || !state.selection.empty) return enter(state, dispatch, view);
    const tr = state.tr;
    if (!linkTypedUrl(state, state.selection.from, tr)) return enter(state, dispatch, view);
    const { state: linked, transactions } = state.applyTransaction(tr);
    // a plugin appended steps to the link (none does today): the key on the state that results, as two steps
    if (transactions.length > 1) {
      dispatch(tr);
      return (view && enter(view.state, dispatch, view)) || true;
    }
    let keyed: Transaction | null = null;
    enter(linked, (t) => (keyed = t), view);
    const done = keyed as Transaction | null;
    if (done) {
      for (const step of done.steps) tr.step(step);
      tr.setSelection(done.selection.map(tr.doc, new Mapping()));
      if (done.storedMarksSet) tr.setStoredMarks(done.storedMarks);
      if (done.scrolledIntoView) tr.scrollIntoView();
    }
    dispatch(tr);
    return true;
  };

/** A pasted plain text's lines as paragraphs; with `link`, the URLs in them as autolinks. */
export function textSlice(text: string, link: boolean): Slice {
  const lines = text.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  return Slice.maxOpen(Fragment.from(lines.map((l) => schema.nodes.paragraph.create(null, l ? lineContent(l, link) : null))));
}

function lineContent(line: string, link: boolean): PMNode[] {
  const found = link ? linksIn(line) : [];
  if (!found.length) return [schema.text(line)];
  const out: PMNode[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) out.push(schema.text(line.slice(at, f.start)));
    out.push(schema.text(line.slice(f.start, f.end), [autoLink(f.href)]));
    at = f.end;
  }
  if (at < line.length) out.push(schema.text(line.slice(at)));
  return out;
}

// ── keeping autolinks live

/** Changed ranges in the final document: [from, to] pairs. */
type Ranges = number[];

/** What the transactions changed, mapped to the end: replaced ranges, and link marks added or removed (a manual link over part of an autolink). */
function changedRanges(trs: readonly Transaction[], include: (tr: Transaction) => boolean): Ranges {
  let ranges: Ranges = [];
  for (const tr of trs) {
    if (!tr.docChanged) continue;
    if (ranges.length) ranges = mapRanges(ranges, tr);
    if (!include(tr)) continue;
    tr.steps.forEach((step, i) => {
      const rest = tr.mapping.slice(i + 1);
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        if (step.mark.type === marks.link) ranges.push(rest.map(step.from, -1), rest.map(step.to, 1));
        return;
      }
      step.getMap().forEach((_oldStart, _oldEnd, start, end) => ranges.push(rest.map(start, -1), rest.map(end, 1)));
    });
  }
  return ranges;
}

function mapRanges(ranges: Ranges, tr: Transaction): Ranges {
  const out: Ranges = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const from = tr.mapping.map(ranges[i]!, -1);
    out.push(from, Math.max(from, tr.mapping.map(ranges[i + 1]!, 1)));
  }
  return out;
}

/** Overlapping or touching ranges as one (a composition retyping one character thousands of times keeps one range). */
function mergeRanges(ranges: Ranges): Ranges {
  if (ranges.length <= 2) return ranges;
  const pairs: [number, number][] = [];
  for (let i = 0; i < ranges.length; i += 2) pairs.push([ranges[i]!, ranges[i + 1]!]);
  pairs.sort((x, y) => x[0] - y[0]);
  const out: Ranges = [];
  for (const [from, to] of pairs) {
    const last = out.length - 1;
    if (last > 0 && from <= out[last]!) out[last] = Math.max(out[last]!, to);
    else out.push(from, to);
  }
  return out;
}

/** Lines touched by the ranges, each once: its content's start and the touched offsets in it. */
function touchedLines(doc: PMNode, ranges: Ranges): Map<number, { block: PMNode; a: number; b: number }> {
  const lines = new Map<number, { block: PMNode; a: number; b: number }>();
  const size = doc.content.size;
  const add = (block: PMNode, start: number, from: number, to: number) => {
    const a = Math.max(0, Math.min(block.content.size, from - start));
    const b = Math.max(a, Math.min(block.content.size, to - start));
    const line = lines.get(start);
    if (line) {
      line.a = Math.min(line.a, a);
      line.b = Math.max(line.b, b);
    } else lines.set(start, { block, a, b });
  };
  for (let i = 0; i < ranges.length; i += 2) {
    const from = Math.max(0, Math.min(size, ranges[i]!));
    const to = Math.max(from, Math.min(size, ranges[i + 1]!));
    for (const pos of from === to ? [from] : [from, to]) {
      const $pos = doc.resolve(pos);
      if ($pos.parent.inlineContent) add($pos.parent, $pos.start(), from, to);
    }
    if (to > from)
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.inlineContent) return true;
        add(node, pos + 1, from, to);
        return false;
      });
  }
  return lines;
}

/** Test builds count the lines reconciled past the fast path (the perf suite checks a keystroke far from links does none). */
export const liveStats = { slow: 0 };

/**
 * One line: every token around [a, b] that held autolink text gets the link
 * it spells now, or none. Tokens end at delimiters and at manual links'
 * edges; a token without autolink text is left alone (plain text links only
 * on a trigger). A manual link touched whose text now spells its own href
 * becomes an autolink (what reopening the draft would make of it). Only
 * differences become steps.
 */
function reconcileLine(tr: Transaction, block: PMNode, start: number, a: number, b: number): void {
  const size = block.content.size;
  const lo = Math.max(0, a - WINDOW);
  const hi = Math.min(size, b + WINDOW);
  const runs = linkRuns(block, lo, hi);
  // the fast path: no link near the change
  if (!runs.length) return;
  liveStats.slow++;
  const auto: Run[] = [];
  const manual: Run[] = [];
  // manual links promoted here (their marks go in the rebuild below)
  const promoted: Mark[] = [];
  for (const r of runs) {
    const touched = r.from <= b && r.to >= a;
    // an autolink reaching out of the window and not edited can't be read whole here: left as it is, a token edge
    if (isAuto(r.mark) && (touched || (r.from >= lo && r.to <= hi))) auto.push(r);
    else if (!isAuto(r.mark) && touched && r.to - r.from <= MAX_URL_LENGTH && spelledHref(block.textBetween(r.from, r.to, undefined, LEAF)) === r.mark.attrs.href) {
      promoted.push(r.mark);
      auto.push({ ...r, mark: autoLink(r.mark.attrs.href as string) });
    } else manual.push(r);
  }
  if (!auto.length) return;
  const text = block.textBetween(lo, hi, undefined, LEAF);
  // tokens end at delimiters and at manual links (one pass, so many links near the caret cost nothing per character)
  const stops = new Uint8Array(hi - lo);
  for (let i = 0; i < stops.length; i++) if (isDelimiter(text.charCodeAt(i))) stops[i] = 1;
  for (const r of manual) stops.fill(1, Math.max(0, r.from - lo), Math.max(0, r.to - lo));
  const stop = (o: number) => o < lo || o >= hi || stops[o - lo] === 1;
  // the span: [a, b] out to token edges, and out to every autolink it meets
  let s = a;
  let e = b;
  // (only while it moves: clamped to the window, an autolink reaching past it would otherwise grow it forever)
  for (;;) {
    while (s > lo && !stop(s - 1)) s--;
    while (e < hi && !stop(e)) e++;
    let ns = s;
    let ne = e;
    for (const r of auto)
      if (r.from <= e && r.to >= s) {
        ns = Math.min(ns, Math.max(lo, r.from));
        ne = Math.max(ne, Math.min(hi, r.to));
      }
    if (ns === s && ne === e) break;
    s = ns;
    e = ne;
  }
  const current = auto.filter((r) => r.from <= e && r.to >= s);
  if (!current.length) return;
  // what each token should carry: the link it spells over its autolink text; failing that, each autolink part that
  // still spells a URL keeps one ("a" typed before "https://x.com" leaves the link as it is). The runs are in order and
  // apart: one cursor walks them with the tokens (a line of thousands of links stays linear).
  const desired: { from: number; to: number; href: string }[] = [];
  const cutAt = (from: number, to: number) => (from === lo && lo > 0) || (to === hi && hi < size);
  let j = 0;
  for (let i = s; i < e; ) {
    while (i < e && stop(i)) i++;
    const ts = i;
    while (i < e && !stop(i)) i++;
    const te = i;
    if (te === ts) continue;
    while (j < current.length && current[j]!.to <= ts) j++;
    const inToken: Run[] = [];
    for (let k = j; k < current.length && current[k]!.from < te; k++) inToken.push(current[k]!);
    if (!inToken.length) continue;
    // a token cut by the window is longer than any link; an autolink wholly inside the window can still be read
    const found = cutAt(ts, te) ? null : linkIn(text.slice(ts - lo, te - lo));
    if (found && inToken.some((r) => r.from < ts + found.end && r.to > ts + found.start)) {
      desired.push({ from: ts + found.start, to: ts + found.end, href: found.href });
      continue;
    }
    for (const r of inToken) {
      const from = Math.max(r.from, ts);
      const to = Math.min(r.to, te);
      const href = cutAt(from, to) ? null : spelledHref(text.slice(from - lo, to - lo));
      if (href) desired.push({ from, to, href });
    }
  }
  const same = !promoted.length && current.length === desired.length && current.every((r, i) => r.from === desired[i]!.from && r.to === desired[i]!.to && r.mark.attrs.href === desired[i]!.href);
  if (same) return;
  // one step for the line, built in one pass: two mark steps per link, each copying the line, were quadratic in a line of
  // many links. The same text, so positions don't move (reconcile puts the selection back).
  const from = Math.min(current[0]!.from, desired[0]?.from ?? Infinity);
  const to = Math.max(current[current.length - 1]!.to, desired[desired.length - 1]?.to ?? -Infinity);
  tr.replaceWith(start + from, start + to, Fragment.fromArray(relinked(block, from, to, desired, promoted)));
}

/**
 * A line's inline content in [from, to) with its autolinks redone in one pass: every autolink (and each promoted
 * manual link) off, the desired ones on; other marks and manual links as they are.
 */
function relinked(block: PMNode, from: number, to: number, desired: { from: number; to: number; href: string }[], promoted: Mark[]): PMNode[] {
  const out: PMNode[] = [];
  let d = 0;
  let offset = 0;
  for (let i = 0, n = block.childCount; i < n && offset < to; i++) {
    const child = block.child(i);
    const cs = offset;
    offset += child.nodeSize;
    if (offset <= from) continue;
    const base = child.marks.filter((m) => !(m.type === marks.link && (isAuto(m) || promoted.some((p) => p.eq(m)))));
    const end = Math.min(offset, to);
    for (let pos = Math.max(cs, from); pos < end; ) {
      while (d < desired.length && desired[d]!.to <= pos) d++;
      const next = desired[d];
      const inside = next !== undefined && next.from <= pos;
      const cut = inside ? Math.min(end, next.to) : Math.min(end, next ? next.from : end);
      const set = inside ? autoLink(next.href).addToSet(base) : base;
      out.push(child.isText ? schema.text(child.text!.slice(pos - cs, cut - cs), set) : child.mark(set));
      pos = cut;
    }
  }
  return out;
}

/** Brings the autolinks in the changed ranges in line with their text. */
export function reconcile(tr: Transaction, ranges: Ranges): void {
  if (!ranges.length) return;
  const selection = tr.selection.toJSON();
  const stored = tr.storedMarks;
  const steps = tr.steps.length;
  for (const [start, { block, a, b }] of touchedLines(tr.doc, ranges)) reconcileLine(tr, block, start, a, b);
  if (tr.steps.length === steps) return;
  // a replace maps positions inside it to its edges: the selection (in a link being edited) goes back where it was
  tr.setSelection(Selection.fromJSON(tr.doc, selection));
  if (stored) tr.setStoredMarks(stored);
}

/** What changed while composing (IME), waiting for the composition to end, and the composition's id (its undo step). */
interface Pending {
  ranges: Ranges;
  composition: unknown;
}

export const liveKey = new PluginKey<Pending>("liveLinks");
const NONE: Pending = { ranges: [], composition: undefined };
const isComposition = (tr: Transaction) => tr.getMeta("composition") !== undefined;

/**
 * Once a composition is over, what it changed is reconciled, in its undo
 * step: the transaction carries its id, which prosemirror-history groups
 * with it (undoing the composition puts back a link it removed).
 */
export function flushLinks(state: EditorState): Transaction | null {
  const pending = liveKey.getState(state);
  if (!pending?.ranges.length) return null;
  const tr = state.tr;
  reconcile(tr, pending.ranges);
  tr.setMeta(liveKey, "flush");
  if (pending.composition !== undefined) tr.setMeta("composition", pending.composition);
  return tr;
}

/** Dispatches the flush when nothing is being composed. */
function flushSoon(view: EditorView): void {
  if (view.isDestroyed || view.composing) return;
  const tr = flushLinks(view.state);
  if (tr) view.dispatch(tr);
}

/** `probe`: test builds time each reconciliation (window.__composer.links, the perf suite's gate on this plugin's own work). */
export function liveLinks(probe?: (name: string, value: number) => void): Plugin<Pending> {
  return new Plugin<Pending>({
    key: liveKey,
    state: {
      init: () => NONE,
      // what changed while composing waits (changing marks there would end the composition), mapped forward
      apply(tr, pending) {
        if (tr.getMeta(liveKey) === "flush") return NONE;
        const ranges = pending.ranges.length && tr.docChanged ? mapRanges(pending.ranges, tr) : pending.ranges;
        if (isComposition(tr)) return { ranges: mergeRanges(ranges.concat(changedRanges([tr], () => true))), composition: tr.getMeta("composition") };
        return ranges === pending.ranges ? pending : { ranges, composition: pending.composition };
      },
    },
    appendTransaction(trs, _old, state) {
      const t0 = import.meta.env.VITE_RENDER_PROBE ? performance.now() : 0;
      const ranges = changedRanges(trs, (tr) => !isComposition(tr) && tr.getMeta(liveKey) === undefined);
      if (!ranges.length) return null;
      const tr = state.tr;
      reconcile(tr, ranges);
      if (import.meta.env.VITE_RENDER_PROBE) probe?.("links", performance.now() - t0);
      return tr.docChanged ? tr.setMeta(liveKey, "own") : null;
    },
    props: {
      handleDOMEvents: {
        // ProseMirror ends a composition without always dispatching: look once its last changes are read (its own microtask)
        compositionend(view) {
          setTimeout(() => flushSoon(view), 0);
          return false;
        },
      },
    },
    view: () => {
      let scheduled = false;
      return {
        update(view: EditorView) {
          if (scheduled || view.composing || !liveKey.getState(view.state)?.ranges.length) return;
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            flushSoon(view);
          });
        },
      };
    },
  });
}

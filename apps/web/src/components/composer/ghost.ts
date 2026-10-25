import { schema } from "@terno/richtext";
import { closeHistory } from "prosemirror-history";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";

/**
 * Ghost text (plan 18 §4.4): a suggestion shown after the caret — not in the
 * document, the history, the draft or the mail, and not even in the editor's
 * DOM. It is drawn on a layer beside the editor, wrapped as the line would
 * continue (`text-indent` at the caret), trimmed to the whole words that fit
 * on the caret's line (what shows is exactly what Tab inserts), and placed in
 * the frame's own animation callback. So a suggestion never makes ProseMirror
 * walk the document or Chromium lay the paragraph out again: in a 10 MB draft
 * it costs what it costs in an empty one.
 *
 * It is asked for 60 ms after the user stops typing at the end of a line,
 * from at most 1,000 characters before the caret (read by walking a bounded
 * number of nodes back from the caret, never the whole document), and shown
 * only if nothing changed meanwhile. Typing its next characters consumes it;
 * anything else dismisses it. Tab accepts it, → accepts a word, Esc dismisses.
 */

export interface GhostHooks {
  enabled(): boolean;
  /** the suggestion for the text before the caret (null: none, or the draft changed meanwhile) */
  suggest(before: string): Promise<string | null>;
  /** a new suggestion is shown (screen readers hear it once) */
  announce(text: string): void;
}

interface GhostState {
  ghost: { text: string; pos: number } | null;
  /** counts the user's typing (not pastes, undo, accepted suggestions): the plugin view asks after each */
  typed: number;
}

type Meta = { set: { text: string; pos: number } } | { clear: true };

export const ghostKey = new PluginKey<GhostState>("ghost");

const WINDOW = 1000;
/** how far past the caret a line is checked for being at its end */
const AFTER = 256;
const SIBLINGS = 4;
export const GHOST_DELAY_MS = 60;

/** What each editor's layer shows now (Tab inserts exactly that), and the layer itself. */
const visible = new WeakMap<EditorView, { text: string; pos: number }>();
const layers = new WeakMap<EditorView, HTMLElement>();

/** The user typed `inserted` at the ghost (one step, nothing deleted): what is left of the ghost, or null. */
function consumed(tr: Transaction, g: NonNullable<GhostState["ghost"]>): string | null {
  if (tr.steps.length !== 1) return null;
  const step = tr.steps[0];
  if (!(step instanceof ReplaceStep) || step.from !== g.pos || step.to !== g.pos) return null;
  const inserted = step.slice.content.textBetween(0, step.slice.content.size);
  if (!inserted || !g.text.startsWith(inserted) || inserted.length >= g.text.length) return null;
  const sel = tr.selection;
  if (!sel.empty || sel.from !== g.pos + inserted.length) return null;
  return g.text.slice(inserted.length);
}

/** Typing, as opposed to a paste, a cut, a drop, undo/redo, an IME composition or an accepted suggestion. */
function isTyping(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  const ui = tr.getMeta("uiEvent");
  if (ui === "paste" || ui === "cut" || ui === "drop") return false;
  if (tr.getMeta("history$") !== undefined || tr.getMeta(ghostKey) !== undefined || tr.getMeta("composition") !== undefined) return false;
  return true;
}

/**
 * The text before the caret for a suggestion, or null where none belongs: a
 * selection, inside a quote, a link or fixed-width text, a centered or
 * right-aligned line, not at the end of the line, or nothing typed on the
 * line. Bounded: at most WINDOW characters back and AFTER forward, through
 * the caret's own block and a few before it.
 */
export function windowAt(state: EditorState): string | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$from;
  const block = $pos.parent;
  if (!block.isTextblock || (block.attrs.align && block.attrs.align !== "left")) return null;
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === schema.nodes.blockquote) return null;
  const marks = state.storedMarks ?? $pos.marks();
  if (marks.some((m) => m.type === schema.marks.link || (m.type === schema.marks.font && m.attrs.value === "mono"))) return null;
  // after the caret, up to a line break: only spaces
  let seen = 0;
  const index = $pos.index();
  for (let i = index; i < block.childCount && seen < AFTER; i++) {
    const child = block.child(i);
    if (child.type === schema.nodes.hard_break) break;
    if (!child.isText) return null;
    const text = i === index ? child.text!.slice($pos.textOffset) : child.text!;
    const part = text.slice(0, AFTER - seen);
    if (/\S/.test(part)) return null;
    seen += part.length;
  }
  if (seen >= AFTER) return null;
  // before the caret: this block's children backwards, then earlier blocks, within WINDOW characters
  const parts: string[] = [];
  let size = 0;
  let line = true;
  let lineHasText = false;
  const take = (s: string) => {
    const piece = s.length > WINDOW - size ? s.slice(s.length - (WINDOW - size)) : s;
    parts.push(piece);
    size += piece.length;
    if (line && /\S/.test(piece)) lineHasText = true;
  };
  const backwards = (node: PMNode, end: number, endOffset: number | null) => {
    for (let i = end; i >= 0 && size < WINDOW; i--) {
      const child = node.child(i);
      if (child.type === schema.nodes.hard_break) {
        if (line && !lineHasText) return false;
        line = false;
        take("\n");
      } else if (child.isText) take(i === end && endOffset !== null ? child.text!.slice(0, endOffset) : child.text!);
    }
    return true;
  };
  const at = $pos.textOffset ? index : index - 1;
  if (!backwards(block, at, $pos.textOffset ? $pos.textOffset : null)) return null;
  if (!lineHasText) return null;
  line = false;
  // a few blocks before this one, at the same level (a greeting line above, the sentence before)
  const container = $pos.node($pos.depth - 1);
  const blockIndex = $pos.index($pos.depth - 1);
  for (let k = 1; k <= SIBLINGS && size < WINDOW && blockIndex - k >= 0; k++) {
    const prev = container.child(blockIndex - k);
    if (!prev.isTextblock) break;
    take("\n");
    if (prev.childCount) backwards(prev, prev.childCount - 1, null);
  }
  return parts.reverse().join("");
}

/**
 * Accepts the shown ghost, or its next word: one undo step of its own. A
 * ghost not on screen yet (it arrived this frame) isn't accepted: Tab does
 * what it does.
 */
export function acceptGhost(view: EditorView, word = false): boolean {
  const g = ghostKey.getState(view.state)?.ghost;
  if (!g) return false;
  const shown = layers.has(view) ? visible.get(view) : g;
  if (!shown || shown.pos !== g.pos || !g.text.startsWith(shown.text)) return false;
  const text = shown.text;
  const take = word ? (/^\s*[^\s]+/.exec(text)?.[0] ?? text) : text;
  const rest = g.text.slice(take.length);
  const tr = view.state.tr.insertText(take, g.pos);
  tr.setSelection(TextSelection.create(tr.doc, g.pos + take.length));
  tr.setMeta(ghostKey, word && rest.trim() ? { set: { text: rest, pos: g.pos + take.length } } : { clear: true });
  view.dispatch(closeHistory(tr).scrollIntoView());
  // what is typed next is another undo step
  view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
  return true;
}

export function dismissGhost(view: EditorView): boolean {
  if (!ghostKey.getState(view.state)?.ghost) return false;
  view.dispatch(view.state.tr.setMeta(ghostKey, { clear: true }).setMeta("addToHistory", false));
  return true;
}

/** A state without its ghost (kept for a remount: a suggestion is never brought back). */
export function withoutGhost(state: EditorState): EditorState {
  return ghostKey.getState(state)?.ghost ? state.apply(state.tr.setMeta(ghostKey, { clear: true }).setMeta("addToHistory", false)) : state;
}

const busy = (ms: number) => {
  for (const end = performance.now() + ms; performance.now() < end; );
};

/** The ghost's leading space and words, each a unit trimming keeps or drops. */
const pieces = (text: string) => text.match(/\s*\S+\s*/g) ?? [];

/**
 * Lays the ghost out after the caret: the layer spans the caret's line box
 * from the block's left edge, indented to the caret, in the caret's own font;
 * only the words that fit on that line are kept. Called from an animation
 * frame, where layout is due anyway.
 */
function place(view: EditorView, layer: HTMLElement, g: { text: string; pos: number }): string | null {
  const parent = layer.parentElement;
  const at = view.domAtPos(g.pos);
  const el = (at.node.nodeType === 3 ? at.node.parentElement : at.node.nodeType === 1 ? (at.node as Element) : null) as HTMLElement | null;
  const block = el?.closest<HTMLElement>("p") ?? null;
  if (!parent || !el || !block || !view.dom.contains(block)) return null;
  let caret: { left: number; top: number; bottom: number };
  try {
    caret = view.coordsAtPos(g.pos, 1);
  } catch {
    return null;
  }
  const box = block.getBoundingClientRect();
  const origin = parent.getBoundingClientRect();
  const style = getComputedStyle(el);
  const indent = caret.left - box.left;
  if (indent < 0 || indent >= box.width) return null;
  // the caret's rect is its glyph box: the line box starts half the leading above it
  const lineHeight = parseFloat(style.lineHeight);
  const glyph = caret.bottom - caret.top;
  const leading = Number.isFinite(lineHeight) && lineHeight > glyph ? (lineHeight - glyph) / 2 : 0;
  // snapped to the block's own line grid (exact for lines of one size)
  const top = Number.isFinite(lineHeight) && lineHeight > 0 ? box.top + Math.round((caret.top - leading - box.top) / lineHeight) * lineHeight : caret.top - leading;
  layer.style.left = `${box.left - origin.left}px`;
  layer.style.top = `${top - origin.top}px`;
  layer.style.width = `${box.width}px`;
  layer.style.textIndent = `${indent}px`;
  // the caret's own type (marks included: bold, size, serif)
  layer.style.fontFamily = style.fontFamily;
  layer.style.fontSize = style.fontSize;
  layer.style.fontWeight = style.fontWeight;
  layer.style.fontStyle = style.fontStyle;
  layer.style.letterSpacing = style.letterSpacing;
  layer.style.lineHeight = style.lineHeight;
  const line = Math.max(glyph, Number.isFinite(lineHeight) ? lineHeight : glyph);
  const parts = pieces(g.text);
  // the longest run of whole words that stays on the caret's line (a binary search: a few small layouts)
  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    layer.textContent = parts.slice(0, mid).join("").trimEnd();
    if (layer.getBoundingClientRect().height <= line * 1.5) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return null;
  const text = parts.slice(0, lo).join("").trimEnd();
  layer.textContent = text;
  return text;
}

export function ghostPlugin(hooksOf: (view: EditorView) => GhostHooks | undefined, probe?: (name: string, value: number) => void): Plugin<GhostState> {
  return new Plugin<GhostState>({
    key: ghostKey,
    state: {
      init: () => ({ ghost: null, typed: 0 }),
      apply(tr, value, _old, state): GhostState {
        const meta = tr.getMeta(ghostKey) as Meta | undefined;
        const typed = isTyping(tr) ? value.typed + 1 : value.typed;
        if (meta && "set" in meta) return { ghost: { text: meta.set.text, pos: meta.set.pos }, typed };
        if (meta && "clear" in meta) return { ghost: null, typed };
        const g = value.ghost;
        if (!g) return typed === value.typed ? value : { ghost: null, typed };
        if (tr.docChanged) {
          // only typing consumes it (a paste or a composition that happens to match doesn't)
          const rest = isTyping(tr) ? consumed(tr, g) : null;
          return { ghost: rest ? { text: rest, pos: g.pos + (g.text.length - rest.length) } : null, typed };
        }
        // the caret moved off it
        const sel = state.selection;
        if (!sel.empty || sel.from !== g.pos) return { ghost: null, typed };
        return value;
      },
    },
    props: {
      handleKeyDown(view, event) {
        const g = ghostKey.getState(view.state)?.ghost;
        if (!g || event.isComposing || event.keyCode === 229) return false;
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
        let handled = false;
        if (event.key === "Tab") handled = acceptGhost(view);
        else if (event.key === "ArrowRight" && view.state.selection.empty && view.state.selection.from === g.pos) handled = acceptGhost(view, true);
        else if (event.key === "Escape") handled = dismissGhost(view);
        if (handled) {
          // the composer's form and the document's shortcuts must not act on it too (they ignore defaultPrevented for Esc)
          event.preventDefault();
          event.stopPropagation();
        }
        return handled;
      },
      handleDOMEvents: {
        blur: (view) => {
          dismissGhost(view);
          return false;
        },
        compositionstart: (view) => {
          // an IME composition goes on undisturbed: the ghost hides at once (it goes with the composed text)
          const layer = layers.get(view);
          if (layer) layer.hidden = true;
          return false;
        },
      },
    },
    view(editor) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let frame = 0;
      let seq = 0;
      let lastTyped = ghostKey.getState(editor.state)?.typed ?? 0;
      const layer = document.createElement("div");
      layer.className = "rt-ghost-layer";
      layer.dataset.testid = "compose-ghost";
      layer.setAttribute("aria-hidden", "true");
      layer.hidden = true;
      const parent = editor.dom.parentElement;
      if (parent) {
        if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
        parent.append(layer);
        layers.set(editor, layer);
      }
      const hide = () => {
        layer.hidden = true;
        layer.textContent = "";
        delete layer.dataset.ghost;
        visible.delete(editor);
      };
      const render = () => {
        frame = 0;
        const g = ghostKey.getState(editor.state)?.ghost;
        if (!g || editor.isDestroyed || editor.composing) return hide();
        const text = place(editor, layer, g);
        if (!text) return hide();
        layer.dataset.ghost = text;
        layer.hidden = false;
        visible.set(editor, { text, pos: g.pos });
      };
      // the window's width changes how the line wraps
      const onResize = () => {
        if (!frame) frame = requestAnimationFrame(render);
      };
      window.addEventListener("resize", onResize);
      const cancel = () => {
        seq++;
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const ask = async (view: EditorView, mine: number) => {
        timer = null;
        const hooks = hooksOf(view);
        if (mine !== seq || !hooks?.enabled() || view.isDestroyed || !view.hasFocus() || !view.editable || view.composing) return;
        const before = windowAt(view.state);
        if (before === null) return;
        const doc = view.state.doc;
        const selection = view.state.selection;
        if (import.meta.env.VITE_RENDER_PROBE) probe?.("ghost-request", performance.now());
        const text = await hooks.suggest(before);
        // shown only if nothing changed meanwhile: the document, the caret, focus, the setting
        if (!text || mine !== seq || view.isDestroyed || view.state.doc !== doc || !view.state.selection.eq(selection) || !view.hasFocus() || !view.editable || view.composing || !hooks.enabled()) return;
        view.dispatch(view.state.tr.setMeta(ghostKey, { set: { text, pos: selection.from } }).setMeta("addToHistory", false));
        if (import.meta.env.VITE_RENDER_PROBE) probe?.("ghost-shown", performance.now());
        hooks.announce(text);
      };
      return {
        update(view, prev) {
          const st = ghostKey.getState(view.state);
          if (!st) return;
          const before = ghostKey.getState(prev)?.ghost ?? null;
          if (st.ghost !== before) {
            // gone: at once; shown or moved: laid out in the frame's animation callback (layout is due then anyway)
            if (!st.ghost) hide();
            else if (!frame) frame = requestAnimationFrame(render);
          }
          if (st.typed !== lastTyped) {
            lastTyped = st.typed;
            // the perf suite's injected regression: work on every typed key while suggestions are on
            if (import.meta.env.VITE_RENDER_PROBE && (window as unknown as { __ternoInject?: string }).__ternoInject === "ghost-busy" && hooksOf(view)?.enabled()) busy(6);
            cancel();
            // typed through the ghost: what is left of it stays, nothing new is asked
            if (st.ghost) return;
            const mine = seq;
            timer = setTimeout(() => void ask(view, mine), GHOST_DELAY_MS);
          } else if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) cancel();
        },
        destroy() {
          cancel();
          if (frame) cancelAnimationFrame(frame);
          window.removeEventListener("resize", onResize);
          layer.remove();
          layers.delete(editor);
          visible.delete(editor);
        },
      };
    },
  });
}

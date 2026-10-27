import { blockStyle, emptyDoc, fromPlainText, parseHtml, restoreSlice, cleanPastedHtml, schema, toEmailHtml, toPlainText, urlIn, MAX_INDENT, type Align } from "@terno/richtext";
import { baseKeymap, chainCommands, createParagraphNear, lift, liftEmptyBlock, newlineInCode, splitBlockAs, toggleMark, wrapIn } from "prosemirror-commands";
import { closeHistory, history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { InputRule, inputRules, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin, Selection, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { FormatCommand, FormatState } from "./controller";
import { ghostPlugin, type GhostHooks } from "./ghost";

/**
 * The composer's ProseMirror editor (plan 16): plugins, commands, shortcuts,
 * paste and the toolbar's state. Lazy (the composer chunk); nothing here
 * runs before a draft opens.
 */

const { marks, nodes } = schema;

// ── the document an editor starts from, and the states kept between mounts

/** A draft's body as a document: its HTML when it has one, else its text (every draft before plan 16). */
export function docOf(html: string, text: string): PMNode {
  if (html) return parseHtml(html);
  return text ? fromPlainText(text) : emptyDoc();
}

/** Lines typed before the editor loaded, after a document (in place of an empty one), one paragraph per line. */
export function appendTyped(doc: PMNode, typed: string): PMNode {
  const lines = typed.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
  if (!lines) return doc;
  const added = lines.split("\n").map((l) => nodes.paragraph.create(null, l ? schema.text(l) : null));
  return isEmpty(doc) ? nodes.doc.create(null, added) : doc.copy(doc.content.append(Fragment.from(added)));
}

/** An empty body: one empty line (nothing to send as HTML). */
export const isEmpty = (doc: PMNode) => doc.childCount === 1 && doc.firstChild!.type === nodes.paragraph && doc.firstChild!.childCount === 0 && doc.firstChild!.attrs.align === "left" && doc.firstChild!.attrs.indent === 0;

/** What a draft carries for a document: mail HTML ('' when empty) and its plain text. */
export function serialize(doc: PMNode): { html: string; text: string } {
  if (isEmpty(doc)) return { html: "", text: "" };
  return { html: toEmailHtml(doc), text: toPlainText(doc) };
}

/** The last editor states by draft (undo history, selection, stored marks), so collapsing and coming back loses none. */
const kept = new Map<string, { state: EditorState; version: number }>();
const KEPT_MAX = 8;
export function keepState(key: string, state: EditorState, version: number): void {
  kept.delete(key);
  kept.set(key, { state, version });
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
}
export function keptState(key: string, version: number): EditorState | null {
  const k = kept.get(key);
  return k && k.version === version ? k.state : null;
}
export const forgetState = (key: string) => kept.delete(key);

// ── commands

/** A formatting command is one undo step of its own (typing groups; ⌘] then ⌘[ undo one at a time). */
const step =
  (cmd: Command): Command =>
  (state, dispatch, view) =>
    cmd(state, dispatch && ((tr) => dispatch(closeHistory(tr))), view);

const markApplies: Command = (state) => !state.selection.empty || state.selection.$from.parent.inlineContent;

/** Bold, italic, underline, strike: on the whole selection unless all of it already has it (Word, Docs, Gmail). */
const toggle = (type: MarkType): Command => step(toggleMark(type, null, { removeWhenPresent: false }));

/** A valued mark (font, size, color, highlight): set to a value, or removed (null) — for the selection or what's typed next. */
export function setMark(type: MarkType, value: string | null): Command {
  return step((state, dispatch) => {
    if (!markApplies(state)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const { empty, ranges } = state.selection;
    if (empty) {
      tr.removeStoredMark(type);
      if (value) tr.addStoredMark(type.create({ value }));
    } else {
      for (const { $from, $to } of ranges) {
        tr.removeMark($from.pos, $to.pos, type);
        if (value) tr.addMark($from.pos, $to.pos, type.create({ value }));
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  });
}

/**
 * New attributes for the lines the selection touches (`update` returns null to
 * leave one as it is), in ONE step: a step per line copies the document each
 * time (quadratic: seconds for a whole 2 MB draft). The top-level blocks in the
 * selection are rebuilt once, untouched nodes reused; sizes don't change, so
 * the selection is put back as it was. False when nothing changed.
 */
function updateLines(tr: Transaction, from: number, to: number, update: (node: PMNode) => Record<string, unknown> | null): boolean {
  const doc = tr.doc;
  const touches = (pos: number, size: number) => (from === to ? pos < from && pos + size > from : pos < to && pos + size > from);
  let changed = false;
  const map = (node: PMNode, pos: number): PMNode => {
    if (node.type === nodes.paragraph) {
      const attrs = touches(pos, node.nodeSize) ? update(node) : null;
      if (!attrs) return node;
      changed = true;
      return node.type.create({ ...node.attrs, ...attrs }, node.content, node.marks);
    }
    if (node.isTextblock || node.isLeaf || !touches(pos, node.nodeSize)) return node;
    const kids: PMNode[] = [];
    let any = false;
    node.forEach((child, offset) => {
      const next = map(child, pos + 1 + offset);
      if (next !== child) any = true;
      kids.push(next);
    });
    return any ? node.copy(Fragment.from(kids)) : node;
  };
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const first = $from.index(0);
  const last = Math.min($to.index(0), doc.childCount - 1);
  const start = $from.posAtIndex(first, 0);
  const blocks: PMNode[] = [];
  let pos = start;
  for (let i = first; i <= last; i++) {
    const child = doc.child(i);
    blocks.push(map(child, pos));
    pos += child.nodeSize;
  }
  if (!changed) return false;
  const selection = tr.selection;
  tr.replaceWith(start, pos, Fragment.from(blocks));
  tr.setSelection(Selection.fromJSON(tr.doc, selection.toJSON()));
  return true;
}

export function setAlign(align: Align): Command {
  return step((state, dispatch) => {
    if (dispatch) {
      const tr = state.tr;
      updateLines(tr, state.selection.from, state.selection.to, (node) => (node.attrs.align !== align ? { align } : null));
      dispatch(tr);
    }
    return true;
  });
}

/** The nearest list around the selection's start: its node, depth and type. */
function listAt($pos: ResolvedPos): { node: PMNode; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type === nodes.bullet_list || n.type === nodes.ordered_list) return { node: n, depth: d };
  }
  return null;
}

/** A list button: off when already that list (one level out), switches a list of the other kind, else wraps. */
function toggleList(type: typeof nodes.bullet_list): Command {
  return (state, dispatch) => {
    const list = listAt(state.selection.$from);
    if (list && list.node.type === type) return liftListItem(nodes.list_item)(state, dispatch);
    if (list) {
      if (dispatch) dispatch(state.tr.setNodeMarkup(state.selection.$from.before(list.depth), type));
      return true;
    }
    return wrapInList(type)(state, dispatch);
  };
}

function paragraphIndent(delta: number): Command {
  return (state, dispatch) => {
    const can = (node: PMNode) => Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent as number) + delta)) !== node.attrs.indent;
    if (!dispatch) {
      // the toolbar asks on every selection change: a pure check that stops at the first line it could move
      // (building the steps for a whole-draft selection was quadratic: seconds at 10,000 lines)
      let any = false;
      const { from, to } = state.selection;
      state.doc.nodesBetween(from, to, (node) => {
        if (any) return false;
        if (node.type === nodes.paragraph) {
          any = can(node);
          return false;
        }
        return true;
      });
      return any;
    }
    const tr = state.tr;
    const changed = updateLines(tr, state.selection.from, state.selection.to, (node) => (can(node) ? { indent: Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent as number) + delta)) } : null));
    if (changed) dispatch(tr);
    return changed;
  };
}

/** Indent: a list item goes one level in; a line moves right. */
const indent: Command = (state, dispatch) => (listAt(state.selection.$from) ? sinkListItem(nodes.list_item)(state, dispatch) : paragraphIndent(1)(state, dispatch));
const outdent: Command = (state, dispatch) => (listAt(state.selection.$from) ? liftListItem(nodes.list_item)(state, dispatch) : paragraphIndent(-1)(state, dispatch));

const inQuote = ($pos: ResolvedPos) => {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === nodes.blockquote) return true;
  return false;
};
const toggleQuote: Command = (state, dispatch) => (inQuote(state.selection.$from) ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch));

/** Remove formatting: every mark but links, for the selection (or what's typed next), and the lines' alignment and indent. */
const clearFormatting: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const tr = state.tr;
  const keep = (m: Mark) => m.type === marks.link;
  if (state.selection.empty) tr.setStoredMarks((state.storedMarks ?? state.selection.$from.marks()).filter(keep));
  else for (const { $from, $to } of state.selection.ranges) for (const type of Object.values(marks)) if (type !== marks.link) tr.removeMark($from.pos, $to.pos, type);
  updateLines(tr, state.selection.from, state.selection.to, (node) => (node.attrs.align !== "left" || node.attrs.indent !== 0 ? { align: "left", indent: 0 } : null));
  dispatch(tr);
  return true;
};

export const COMMANDS: Record<FormatCommand, Command> = {
  undo,
  redo,
  bold: toggle(marks.bold),
  italic: toggle(marks.italic),
  underline: toggle(marks.underline),
  strike: toggle(marks.strike),
  orderedList: step(toggleList(nodes.ordered_list)),
  bulletList: step(toggleList(nodes.bullet_list)),
  indent: step(indent),
  outdent: step(outdent),
  quote: step(toggleQuote),
  clear: step(clearFormatting),
};

// ── links

interface LinkRun {
  from: number;
  to: number;
  mark: Mark;
}

/** The link the caret is inside (or the selection lies within): its range and href. */
export function linkAt(state: EditorState): { from: number; to: number; href: string } | null {
  const { $from, $to, empty } = state.selection;
  const parent = $from.parent;
  if (!parent.inlineContent || (!empty && $to.parent !== parent)) return null;
  const at = $from.parentOffset;
  const end = $to.parentOffset;
  // runs of children carrying the same link, in order
  const runs: LinkRun[] = [];
  let offset = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const m = child.marks.find((x) => x.type === marks.link);
    const last = runs[runs.length - 1];
    if (m && last && last.to === offset && last.mark.eq(m)) last.to = offset + child.nodeSize;
    else if (m) runs.push({ from: offset, to: offset + child.nodeSize, mark: m });
    offset += child.nodeSize;
  }
  // collapsed: strictly inside (a caret just after a link types outside it); a selection: within it
  const hit = runs.find((r) => (empty ? at > r.from && at < r.to : at >= r.from && end <= r.to));
  if (!hit) return null;
  const start = $from.start();
  return { from: start + hit.from, to: start + hit.to, href: hit.mark.attrs.href as string };
}

/** Links (or relinks) a range; with `text`, the range's text becomes it (keeping the marks at its start). */
export function applyLink(view: EditorView, range: { from: number; to: number }, href: string, text?: string): void {
  const { state } = view;
  const link = marks.link.create({ href });
  let tr = state.tr;
  let { from, to } = range;
  // a caret always inserts (the URL itself when no text was given); a range is retyped only when its text changed
  if (from === to || (text !== undefined && text !== state.doc.textBetween(from, to))) {
    const at = state.doc.resolve(from);
    const kept = (from === to ? (state.storedMarks ?? at.marks()) : (at.nodeAfter?.marks ?? at.marks())).filter((m) => m.type !== marks.link);
    const value = text?.trim() ? text : href.replace(/^mailto:/, "");
    tr = tr.replaceWith(from, to, schema.text(value, link.addToSet(kept)));
    to = from + value.length;
  } else {
    tr = tr.removeMark(from, to, marks.link).addMark(from, to, link);
  }
  // the caret after the link, typing outside it (links aren't inclusive)
  tr.setSelection(TextSelection.create(tr.doc, to)).setStoredMarks(null);
  view.dispatch(closeHistory(tr.scrollIntoView()));
}

export function removeLink(view: EditorView, range: { from: number; to: number }): void {
  view.dispatch(closeHistory(view.state.tr.removeMark(range.from, range.to, marks.link)));
}

/** A URL just typed, before the caret, becomes a link (on space or Enter). */
function linkTypedUrl(state: EditorState, end: number, tr: Transaction): boolean {
  const $end = state.doc.resolve(end);
  const before = $end.parent.textBetween(Math.max(0, $end.parentOffset - 500), $end.parentOffset, undefined, "￼");
  const m = /(?:^|\s)((?:https?:\/\/|www\.)\S+)$/.exec(before);
  if (!m) return false;
  // trailing punctuation stays outside the link ("see https://x.example.")
  const url = m[1]!.replace(/[.,;:!?)\]]+$/, "");
  const href = urlIn(url);
  if (!href) return false;
  const from = end - m[1]!.length;
  const to = from + url.length;
  if (state.doc.rangeHasMark(from, to, marks.link)) return false;
  tr.addMark(from, to, marks.link.create({ href }));
  return true;
}

/** A space after a URL links it (and types the space, outside the link). */
const autolink = new InputRule(/\s$/, (state, match, start, end) => {
  const tr = state.tr;
  if (!linkTypedUrl(state, start, tr)) return null;
  return tr.insertText(match[0], start, end);
});

/** Enter after a typed URL links it, then does what Enter does, from the state with the link (one chain, no stale state). */
const withAutolink =
  (enter: Command): Command =>
  (state, dispatch, view) => {
    if (dispatch && view && state.selection.empty) {
      const tr = state.tr;
      if (linkTypedUrl(state, state.selection.from, tr)) {
        dispatch(tr);
        return enter(view.state, dispatch, view) || true;
      }
    }
    return enter(state, dispatch, view);
  };

// ── the toolbar's state

/** The marks shared by everything in the selection (or what's typed next at a caret); stops as soon as nothing is shared. */
function sharedMarks(state: EditorState): readonly Mark[] {
  const { empty, $from, from, to } = state.selection;
  if (empty) return state.storedMarks ?? $from.marks();
  let shared: readonly Mark[] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (shared && shared.length === 0) return false;
    if (!node.isText) return true;
    shared = shared === null ? node.marks : shared.filter((m) => m.isInSet(node.marks));
    return false;
  });
  return shared ?? $from.marks();
}

export function formatState(state: EditorState, editable: boolean): FormatState {
  const shared = sharedMarks(state);
  const value = (type: MarkType) => (shared.find((m) => m.type === type)?.attrs.value as string | undefined) ?? null;
  const $from = state.selection.$from;
  const list = listAt($from);
  return {
    bold: marks.bold.isInSet(shared) !== undefined,
    italic: marks.italic.isInSet(shared) !== undefined,
    underline: marks.underline.isInSet(shared) !== undefined,
    strike: marks.strike.isInSet(shared) !== undefined,
    font: value(marks.font) as FormatState["font"],
    size: value(marks.size) as FormatState["size"],
    color: value(marks.color),
    highlight: value(marks.highlight),
    align: ($from.parent.type === nodes.paragraph ? $from.parent.attrs.align : "left") as Align,
    list: list ? (list.node.type === nodes.ordered_list ? "ordered" : "bullet") : null,
    quote: inQuote($from),
    link: linkAt(state) !== null,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    canIndent: indent(state),
    canOutdent: outdent(state),
    editable,
  };
}

export function sameFormat(a: FormatState, b: FormatState): boolean {
  for (const k of Object.keys(a) as (keyof FormatState)[]) if (a[k] !== b[k]) return false;
  return true;
}

// ── the editor

export interface EditorHooks {
  /** a document change (the user's): the draft becomes dirty */
  onChange(): void;
  /** any state change (selection too): the toolbar and the link bubble follow */
  onUpdate(): void;
  /** ⌘K */
  onLink(): void;
  /** links in mail open outside the app */
  openLink(href: string): void;
  /** plan 18: ghost text */
  ghost?: GhostHooks;
}

/** Plain text pasted keeps its lines: one paragraph per line, empty lines included (as a plain draft opens). */
function textSlice(text: string): Slice {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  return Slice.maxOpen(Fragment.from(lines.map((l) => nodes.paragraph.create(null, l ? schema.text(l) : null))));
}

const { Escape: _escape, ...BASE_KEYS } = baseKeymap;

/** Test builds: ghost timings (window.__composer), for the perf suite. */
function ghostProbe(name: string, value: number) {
  const w = window as unknown as { __composer?: Record<string, number[]> };
  ((w.__composer ??= {})[name] ??= []).push(value);
}

/** Each view's hooks (plugins are shared by kept states across mounts: they look the hooks up by view). */
const viewHooks = new WeakMap<EditorView, EditorHooks>();

export function createPlugins(): Plugin[] {
  const mod: Record<string, Command> = {
    "Mod-b": COMMANDS.bold,
    "Mod-i": COMMANDS.italic,
    "Mod-u": COMMANDS.underline,
    "Mod-Shift-x": COMMANDS.strike,
    "Mod-Shift-7": COMMANDS.orderedList,
    "Mod-Shift-8": COMMANDS.bulletList,
    "Mod-]": COMMANDS.indent,
    "Mod-[": COMMANDS.outdent,
    "Mod-\\": COMMANDS.clear,
    "Mod-z": undo,
    "Mod-Shift-z": redo,
    "Mod-y": redo,
    "Mod-k": (_state, _dispatch, view) => {
      if (view) viewHooks.get(view)?.onLink();
      return true;
    },
    // in a list, Tab moves the item (elsewhere it leaves the editor, as everywhere in the app)
    Tab: (state, dispatch) => (listAt(state.selection.$from) ? sinkListItem(nodes.list_item)(state, dispatch) || true : false),
    "Shift-Tab": (state, dispatch) => (listAt(state.selection.$from) ? liftListItem(nodes.list_item)(state, dispatch) || true : false),
    // a new line keeps the line's alignment and indent (as Docs and Gmail do)
    Enter: withAutolink(chainCommands(splitListItem(nodes.list_item), newlineInCode, createParagraphNear, liftEmptyBlock, splitBlockAs((node) => (node.type === nodes.paragraph ? { type: nodes.paragraph, attrs: node.attrs } : null)))),
    "Shift-Enter": (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
      return true;
    },
    Backspace: undoInputRule,
  };
  return [
    // first: its Tab, → and Esc win over the keymaps below while a suggestion shows
    ghostPlugin((view) => viewHooks.get(view)?.ghost, ghostProbe),
    history(),
    inputRules({
      rules: [
        wrappingInputRule(/^\s*([-*])\s$/, nodes.bullet_list),
        wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list, (m) => ({ start: Number(m[1]) }), (m, node) => node.childCount + (node.attrs.start as number) === Number(m[1])),
        autolink,
      ],
    }),
    keymap(mod),
    // Esc belongs to the composer (collapse, leave), not to "select the parent node"
    keymap(BASE_KEYS),
    new Plugin({
      props: {
        // NBSP typed (⌥Space) reads as a space: mail encodes runs of spaces with it, and a draft's text stays plain
        handleTextInput(view, from, to, text) {
          if (!text.includes("\u00a0")) return false;
          view.dispatch(view.state.tr.insertText(text.replace(/\u00a0/g, " "), from, to));
          return true;
        },
        transformPastedHTML: (html) => cleanPastedHtml(html),
        transformPasted: (slice) => restoreSlice(slice),
        clipboardTextParser: (text) => textSlice(text),
        handlePaste(view, event) {
          // ⇧⌘V (ProseMirror's own plain-paste test): the text goes in as text, a URL included
          const input = (view as unknown as { input?: { shiftKey?: boolean; lastKeyCode?: number } }).input;
          if (input?.shiftKey && input.lastKeyCode !== 45) return false;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const href = urlIn(text);
          if (!href) return false;
          const { state } = view;
          const { from, to, empty } = state.selection;
          // a URL pasted over a selection links it; alone, it goes in as a link
          if (!empty && state.doc.resolve(from).parent === state.doc.resolve(to).parent) applyLink(view, { from, to }, href);
          else applyLink(view, { from, to }, href, text.trim());
          return true;
        },
        handleDOMEvents: {
          click(view, event) {
            const a = (event.target as HTMLElement).closest?.("a[href]");
            if (!a || !(event.metaKey || event.ctrlKey)) return false;
            event.preventDefault();
            viewHooks.get(view)?.openLink(a.getAttribute("href")!);
            return true;
          },
        },
      },
    }),
  ];
}

/**
 * A line whose alignment or indent changes keeps its element: the style is
 * updated in place. ProseMirror would otherwise replace it, and replacing
 * thousands of lines under a whole-draft selection took seconds (each removal
 * updates the live selection).
 */
function paragraphView(initial: PMNode) {
  const dom = document.createElement("p");
  const apply = (node: PMNode) => {
    const style = blockStyle(node.attrs);
    if (style) dom.setAttribute("style", style);
    else dom.removeAttribute("style");
  };
  apply(initial);
  return {
    dom,
    contentDOM: dom,
    update(node: PMNode) {
      if (node.type !== nodes.paragraph) return false;
      apply(node);
      return true;
    },
  };
}

export interface RichEditor {
  view: EditorView;
  destroy(): void;
}

export function createEditor(
  mount: HTMLElement,
  o: { state: EditorState; attributes: Record<string, string>; editable: () => boolean; hooks: EditorHooks },
): RichEditor {
  const view: EditorView = new EditorView(mount, {
    state: o.state,
    nodeViews: { paragraph: (node) => paragraphView(node) },
    attributes: o.attributes,
    editable: o.editable,
    dispatchTransaction(tr) {
      if (!o.editable()) return;
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) o.hooks.onChange();
      o.hooks.onUpdate();
    },
  });
  viewHooks.set(view, o.hooks);
  return { view, destroy: () => view.destroy() };
}

/** A fresh state for a document (the plugins are the editor's own). */
export function newState(doc: PMNode): EditorState {
  return EditorState.create({ doc, plugins: PLUGINS, selection: TextSelection.atEnd(doc) });
}
const PLUGINS = createPlugins();

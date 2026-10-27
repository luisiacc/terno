/**
 * Live autolinks (plan 39) on editor states, without a DOM, through the
 * editor's own plugins: typing goes through the input rules and the NBSP
 * handler as ProseMirror would call them, keys through the keymaps. After
 * every step an autolink's href is what its text spells.
 */
import { cleanPastedHtml, parseHtml, schema, spelledHref } from "@terno/richtext";
import { JSDOM } from "jsdom";
import { closeHistory, redo, undo } from "prosemirror-history";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { flushLinks, linkTypedUrl, liveKey, liveStats, reconcile, textSlice } from "./autolink";
import { applyLink, createPlugins } from "./editor";

const { marks, nodes } = schema;
const plugins = createPlugins();

interface Stand {
  state: EditorState;
  composing: boolean;
  /** transactions appended per dispatch (root + what plugins added) */
  appended: number[];
  dispatch(tr: Transaction): void;
}

function editor(...blocks: PMNode[]): Stand & EditorView {
  const doc = nodes.doc.create(null, blocks.length ? blocks : [nodes.paragraph.create()]);
  const v: Stand = {
    state: EditorState.create({ doc, plugins, selection: TextSelection.atEnd(doc) }),
    composing: false,
    appended: [],
    dispatch(tr: Transaction) {
      const { state, transactions } = v.state.applyTransaction(tr);
      v.appended.push(transactions.length);
      v.state = state;
      // (while a composition's changes wait, its links do too)
      if (!liveKey.getState(state)!.ranges.length) honest(state);
    },
  };
  return v as Stand & EditorView;
}

const p = (...c: (PMNode | string)[]) => nodes.paragraph.create(null, c.map((x) => (typeof x === "string" ? schema.text(x) : x)));
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const auto = (href: string) => marks.link.create({ href, auto: true });
const manual = (href: string) => marks.link.create({ href });

/** Types as ProseMirror does: each character offered to handleTextInput (input rules, the NBSP handler), else inserted. */
function type(v: EditorView, text: string, composition?: number) {
  for (const ch of text) {
    const { from, to } = v.state.selection;
    const deflt = () => {
      const tr = v.state.tr.insertText(ch, from, to);
      return composition === undefined ? tr : tr.setMeta("composition", composition);
    };
    const handled = v.state.plugins.some((pl) => pl.props.handleTextInput?.call(pl, v, from, to, ch, deflt) === true);
    if (!handled) v.dispatch(deflt());
  }
}

function key(v: EditorView, name: string, shift = false) {
  const event = { key: name, keyCode: name === "Enter" ? 13 : 0, shiftKey: shift, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {} } as unknown as KeyboardEvent;
  return v.state.plugins.some((pl) => pl.props.handleKeyDown?.call(pl, v, event) === true);
}

/** Backspace as the browser does it: the character before the caret goes. */
function backspace(v: EditorView, n = 1) {
  for (let i = 0; i < n; i++) {
    const { from } = v.state.selection;
    v.dispatch(v.state.tr.delete(from - 1, from));
  }
}

const caret = (v: EditorView, pos: number) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
/** A new undo step from here. */
const cut = (v: EditorView) => v.dispatch(closeHistory(v.state.tr));
/** Position just after the first occurrence of `s` in the first line. */
const after = (v: EditorView, s: string) => 1 + v.state.doc.firstChild!.textContent.indexOf(s) + s.length;

/** The links of the document as runs: text, href, auto. */
const links = (state: EditorState) => runsOf(state).map(({ text, href, auto: a }) => ({ text, href, auto: a }));

function runsOf(state: EditorState) {
  const out: { text: string; href: string; auto: boolean; mark: Mark }[] = [];
  state.doc.descendants((node) => {
    if (!node.inlineContent) return true;
    let last: (typeof out)[number] | null = null;
    node.forEach((child) => {
      const m = child.marks.find((x) => x.type === marks.link);
      const text = child.isText ? child.text! : "￼";
      if (m && last && last.mark.eq(m)) last.text += text;
      else if (m) out.push((last = { text, href: m.attrs.href as string, auto: m.attrs.auto as boolean, mark: m }));
      else last = null;
    });
    return false;
  });
  return out;
}

/** The invariant: every autolink's href is what its text spells. */
function honest(state: EditorState) {
  for (const r of runsOf(state)) if (r.auto) expect(spelledHref(r.text), `autolink "${r.text}" → ${r.href}`).toBe(r.href);
}

const text = (v: EditorView) => v.state.doc.textContent;

describe("the user's scenario", () => {
  it("https://santo.com, delete .com, type qwe.com: one link to https://santoqwe.com, and undo/redo walk back exactly", () => {
    const v = editor();
    type(v, "https://santo.com ");
    expect(links(v.state)).toEqual([{ text: "https://santo.com", href: "https://santo.com", auto: true }]);
    caret(v, after(v, ".com"));
    const states: EditorState[] = [];
    for (let i = 0; i < 4; i++) {
      cut(v);
      states.push(v.state);
      backspace(v);
    }
    expect(links(v.state)).toEqual([{ text: "https://santo", href: "https://santo", auto: true }]);
    for (const ch of "qwe.com") {
      cut(v);
      states.push(v.state);
      type(v, ch);
    }
    expect(text(v)).toBe("https://santoqwe.com ");
    expect(links(v.state)).toEqual([{ text: "https://santoqwe.com", href: "https://santoqwe.com", auto: true }]);
    const end = v.state;
    // undo walks back through every state, text and links together
    for (let i = states.length - 1; i >= 0; i--) {
      undo(v.state, v.dispatch);
      expect(v.state.doc.eq(states[i]!.doc), `undo ${i}`).toBe(true);
    }
    while (redo(v.state, v.dispatch));
    expect(v.state.doc.eq(end.doc)).toBe(true);
  });
});

describe("editing an autolink", () => {
  const linked = (url: string) => {
    const v = editor();
    type(v, `ver ${url} fin`);
    expect(links(v.state).length).toBe(1);
    return v;
  };

  it("deleting or extending the TLD", () => {
    const v = linked("https://santo.com");
    caret(v, after(v, ".com"));
    backspace(v, 2);
    expect(links(v.state)).toEqual([{ text: "https://santo.c", href: "https://santo.c", auto: true }]);
    type(v, "om.mx");
    expect(links(v.state)).toEqual([{ text: "https://santo.com.mx", href: "https://santo.com.mx", auto: true }]);
  });

  it("typing in the middle (the mark is inherited there)", () => {
    const v = linked("https://example.com/a");
    caret(v, after(v, "https://exa"));
    type(v, "XY");
    expect(links(v.state)).toEqual([{ text: "https://exaXYmple.com/a", href: "https://exaXYmple.com/a", auto: true }]);
  });

  it("deleting the s of https, then the whole scheme", () => {
    const v = linked("https://santo.com");
    caret(v, after(v, "https"));
    backspace(v);
    expect(links(v.state)).toEqual([{ text: "http://santo.com", href: "http://santo.com", auto: true }]);
    caret(v, after(v, "http://"));
    backspace(v, 7);
    expect(text(v)).toBe("ver santo.com fin");
    expect(links(v.state)).toEqual([]);
  });

  it("deleting the scheme of a www. URL (selected) leaves the www. link; one character at a time passes through text that spells nothing", () => {
    const v = linked("https://www.santo.com");
    v.dispatch(v.state.tr.delete(after(v, "ver "), after(v, "https://")));
    expect(links(v.state)).toEqual([{ text: "www.santo.com", href: "https://www.santo.com", auto: true }]);
    const w = linked("https://www.santo.com");
    caret(w, after(w, "https://"));
    backspace(w);
    expect(links(w.state)).toEqual([]);
  });

  it("backspacing through the whole link leaves nothing linked", () => {
    const v = linked("https://santo.com");
    caret(v, after(v, ".com"));
    for (let i = 0; i < "https://santo.com".length; i++) {
      backspace(v);
      for (const l of links(v.state)) expect(spelledHref(l.text)).toBe(l.href);
    }
    expect(text(v)).toBe("ver  fin");
    expect(links(v.state)).toEqual([]);
  });

  it("selecting part of it and typing over it", () => {
    const v = linked("https://santo.com");
    const from = after(v, "https://");
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, from + "santo".length)));
    type(v, "x");
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
    // the selection over the scheme: what is left spells nothing
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, after(v, "ver "), after(v, "https://"))));
    type(v, "y");
    expect(links(v.state)).toEqual([]);
  });

  it("a space typed inside splits it: the left keeps a link while it is a URL, the right is text", () => {
    const v = linked("https://santo.com/a");
    caret(v, after(v, ".com"));
    type(v, " ");
    expect(text(v)).toBe("ver https://santo.com /a fin");
    expect(links(v.state)).toEqual([{ text: "https://santo.com", href: "https://santo.com", auto: true }]);
  });

  it("a bracket or a letter typed right before it leaves it as it is (the letter outside)", () => {
    const v = linked("https://santo.com");
    caret(v, after(v, "ver "));
    type(v, "(");
    expect(links(v.state)).toEqual([{ text: "https://santo.com", href: "https://santo.com", auto: true }]);
    type(v, "a");
    expect(text(v)).toBe("ver (ahttps://santo.com fin");
    expect(links(v.state)).toEqual([{ text: "https://santo.com", href: "https://santo.com", auto: true }]);
    // and editing it then still follows its text
    caret(v, after(v, ".com"));
    backspace(v);
    expect(links(v.state)).toEqual([{ text: "https://santo.co", href: "https://santo.co", auto: true }]);
  });

  it("a line break typed inside splits it (a break ends a token)", () => {
    const v = linked("https://santo.com/a");
    caret(v, after(v, ".com"));
    key(v, "Enter", true);
    expect(links(v.state)).toEqual([{ text: "https://santo.com", href: "https://santo.com", auto: true }]);
  });

  it("text typed right after it, then a space, then more: only the word it is in grows it", () => {
    const v = editor();
    type(v, "https://a.com ");
    caret(v, after(v, ".com"));
    type(v, "/x");
    expect(links(v.state)).toEqual([{ text: "https://a.com/x", href: "https://a.com/x", auto: true }]);
    caret(v, v.state.doc.content.size - 1);
    type(v, "more");
    expect(text(v)).toBe("https://a.com/x more");
    expect(links(v.state)).toEqual([{ text: "https://a.com/x", href: "https://a.com/x", auto: true }]);
  });

  it("each of these steps converges: the plugin appends one transaction at most, and nothing on its own", () => {
    const v = linked("https://santo.com");
    caret(v, after(v, ".com"));
    backspace(v, 4);
    type(v, "qwe.com");
    expect(Math.max(...v.appended)).toBeLessThanOrEqual(2);
  });
});

describe("manual links are never rewritten", () => {
  it("typing in or after a labelled link, or one whose text is another URL, leaves its href", () => {
    const v = editor(p("a ", t("click", manual("https://x.com")), " ", t("https://real.example", manual("https://tracker.example/r")), " b"));
    caret(v, after(v, "cl"));
    type(v, "zz");
    caret(v, after(v, "https://real"));
    type(v, "ly");
    // right after it: outside the (non-inclusive) link, and the link stays as it is
    caret(v, after(v, "really.example"));
    type(v, "/x");
    expect(text(v)).toBe("a clzzick https://really.example/x b");
    expect(links(v.state)).toEqual([
      { text: "clzzick", href: "https://x.com", auto: false },
      { text: "https://really.example", href: "https://tracker.example/r", auto: false },
    ]);
  });

  it("an autolink next to a manual link (no space) stays its own link; the manual one is untouched", () => {
    const v = editor(p(t("aquí", manual("https://m.example"))));
    type(v, "https://x.com ");
    expect(links(v.state)).toEqual([
      { text: "aquí", href: "https://m.example", auto: false },
      { text: "https://x.com", href: "https://x.com", auto: true },
    ]);
    caret(v, after(v, "aquí"));
    type(v, "/");
    expect(links(v.state)[0]).toEqual({ text: "aquí", href: "https://m.example", auto: false });
  });

  it("a manual link applied over part of an autolink: the leftovers link to what they spell, or not at all", () => {
    const v = editor();
    type(v, "https://santo.com/a ");
    const from = after(v, "https://santo.com");
    const to = from + 2;
    // the link dialog over "/a"
    v.dispatch(v.state.tr.removeMark(from, to, marks.link).addMark(from, to, manual("https://other.example")));
    expect(links(v.state)).toEqual([
      { text: "https://santo.com", href: "https://santo.com", auto: true },
      { text: "/a", href: "https://other.example", auto: false },
    ]);
    const v2 = editor();
    type(v2, "https://santo.com ");
    const f2 = after(v2, "https://");
    v2.dispatch(v2.state.tr.removeMark(f2, f2 + 5, marks.link).addMark(f2, f2 + 5, manual("https://other.example")));
    expect(links(v2.state)).toEqual([{ text: "santo", href: "https://other.example", auto: false }]);
  });

  it("a manual link whose text comes to spell its own href becomes an autolink (what reopening it would make)", () => {
    const v = editor(p(t("https://x.cm", manual("https://x.com"))));
    // typed strictly inside the link, the mark is inherited
    caret(v, after(v, "x.c"));
    type(v, "a");
    expect(links(v.state)).toEqual([{ text: "https://x.cam", href: "https://x.com", auto: false }]);
    backspace(v);
    type(v, "o");
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
    type(v, "z");
    expect(links(v.state)).toEqual([{ text: "https://x.cozm", href: "https://x.cozm", auto: true }]);
  });

  it("applyLink: a link made in the dialog whose text spells its href is an autolink; a labelled one isn't", () => {
    const v = editor(p("hola "));
    applyLink(v, { from: 6, to: 6 }, "https://www.x.com", "www.x.com");
    expect(links(v.state)).toEqual([{ text: "www.x.com", href: "https://www.x.com", auto: true }]);
    applyLink(v, { from: 1, to: 5 }, "https://y.com");
    expect(links(v.state)[0]).toEqual({ text: "hola", href: "https://y.com", auto: false });
    // right after a word (no space): the link the dialog made stays
    const w = editor(p("hola"));
    applyLink(w, { from: 5, to: 5 }, "https://www.x.com", "www.x.com");
    expect(links(w.state)).toEqual([{ text: "www.x.com", href: "https://www.x.com", auto: true }]);
  });
});

describe("making a link where the user ends the word", () => {
  it("space, a typed NBSP (it goes in as a space), Enter and ⇧Enter link the URL before them", () => {
    const v = editor();
    type(v, "https://a.com ");
    type(v, "https://b.com ");
    type(v, "https://c.com");
    key(v, "Enter", true);
    type(v, "https://d.com");
    key(v, "Enter");
    expect(v.state.doc.textContent).toBe("https://a.com https://b.com https://c.com￼https://d.com".replace("￼", ""));
    expect(v.state.doc.textBetween(0, v.state.doc.content.size, "\n", "↵")).toBe("https://a.com https://b.com https://c.com↵https://d.com\n");
    expect(links(v.state).map((l) => l.href)).toEqual(["https://a.com", "https://b.com", "https://c.com", "https://d.com"]);
  });

  it("Enter after a URL is one undo step: the line split and the link go together", () => {
    const v = editor();
    type(v, "ver https://a.com");
    cut(v);
    const before = v.state.doc;
    key(v, "Enter");
    expect(v.state.doc.childCount).toBe(2);
    expect(links(v.state).length).toBe(1);
    undo(v.state, v.dispatch);
    expect(v.state.doc.eq(before)).toBe(true);
    redo(v.state, v.dispatch);
    expect(v.state.doc.childCount).toBe(2);
    expect(links(v.state).length).toBe(1);
  });

  it("trailing punctuation and wrapping stay outside; quotes, brackets, angle brackets", () => {
    for (const [typed, linkText] of [
      ["see https://x.com. ", "https://x.com"],
      ["(https://x.com) ", "https://x.com"],
      ["<https://x.com> ", "https://x.com"],
      ['"https://x.com" ', "https://x.com"],
      ["“https://x.com” ", "https://x.com"],
      ["https://en.wikipedia.org/wiki/Foo_(bar) ", "https://en.wikipedia.org/wiki/Foo_(bar)"],
      ["mira www.x.com, ", "www.x.com"],
      ["escribe a ana@x.com. ", "ana@x.com"],
    ]) {
      const v = editor();
      type(v, typed!);
      expect(links(v.state).map((l) => l.text), typed).toEqual([linkText]);
    }
  });

  it("not: other schemes, bare hosts, fixed-width text, over a link", () => {
    for (const typed of ["javascript:alert(1) ", "data:text/html,x ", "file:///etc ", "example.com ", "ahttps://x.com "]) {
      const v = editor();
      type(v, typed);
      expect(links(v.state), typed).toEqual([]);
    }
    const mono = marks.font.create({ value: "mono" });
    const v = editor(p(t("https://x.com", mono)));
    expect(linkTypedUrl(v.state, v.state.doc.content.size - 1, v.state.tr)).toBe(false);
    const linkedAlready = editor(p(t("https://x.com", manual("https://y.com"))));
    expect(linkTypedUrl(linkedAlready.state, linkedAlready.state.doc.content.size - 1, linkedAlready.state.tr)).toBe(false);
  });

  it("inside bold: the link goes over the formatting, which stays", () => {
    const bold = marks.bold.create();
    const v = editor(p(t("https://x.com", bold)));
    type(v, " ");
    const node = v.state.doc.firstChild!.firstChild!;
    expect(node.marks.some((m) => m.type === marks.bold)).toBe(true);
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
  });

  it("very long URLs: 600 and 8,000 characters link (no 500 look-back), past the cap don't", () => {
    for (const [n, linked] of [
      [600, true],
      [8000, true],
      [8193, false],
    ] as const) {
      const url = `https://x.com/${"a".repeat(n - 14)}`;
      const v = editor(p(`ver ${url}`));
      type(v, " ");
      expect(links(v.state).length, String(n)).toBe(linked ? 1 : 0);
    }
  });

  it("in a list item and a quote, at the start and the end", () => {
    const li = nodes.bullet_list.create(null, [nodes.list_item.create(null, [p("https://a.com")])]);
    const v = editor(li);
    type(v, " fin");
    caret(v, 3);
    expect(links(v.state).map((l) => l.text)).toEqual(["https://a.com"]);
    const q = editor(nodes.blockquote.create(null, [p("x https://b.com")]));
    key(q, "Enter");
    expect(links(q.state).map((l) => l.text)).toEqual(["https://b.com"]);
  });
});

describe("paste", () => {
  it("a plain text's URLs link; as plain (⇧⌘V) nothing does", () => {
    const linked = textSlice("see https://a.com, and www.b.com\nor ana@c.com", true);
    const hrefs: string[] = [];
    linked.content.descendants((n) => {
      const m = n.marks.find((x) => x.type === marks.link);
      if (m) hrefs.push(`${n.text}→${m.attrs.href}${m.attrs.auto ? "" : " (manual)"}`);
    });
    expect(hrefs).toEqual(["https://a.com→https://a.com", "www.b.com→https://www.b.com", "ana@c.com→mailto:ana@c.com"]);
    let any = false;
    textSlice("see https://a.com", false).content.descendants((n) => void (any ||= n.marks.length > 0));
    expect(any).toBe(false);
  });

  it("a pasted autolink whose href its text doesn't spell (a partial copy, a forged data-rt-auto) is put right, or unlinked", () => {
    const { window } = new JSDOM("<!doctype html><html><body></body></html>");
    const slice = (html: string) => {
      const d = parseHtml(cleanPastedHtml(`<div data-pm-slice="1 1 []">${html}</div>`, window.document.implementation), window.document.implementation);
      return d.slice(1, d.content.size - 1);
    };
    const v = editor(p("a  b  c"));
    v.dispatch(v.state.tr.replace(3, 3, slice('<a href="https://santo.com" data-rt-auto="">https://santo.co</a>')));
    caret(v, after(v, "b "));
    v.dispatch(v.state.tr.replace(v.state.selection.from, v.state.selection.from, slice('<a href="https://evil.example" data-rt-auto="">click here</a>')));
    expect(text(v)).toBe("a https://santo.co b click here c");
    expect(links(v.state)).toEqual([{ text: "https://santo.co", href: "https://santo.co", auto: true }]);
  });

  it("a paste over lines with autolinks is reconciled line by line", () => {
    const v = editor(p(t("https://a.com", auto("https://a.com"))), p(t("https://b.com", auto("https://b.com"))));
    // a paste that ends each line's link with ".mx" (one replace step spanning both lines)
    const a = after(v, "https://a.com");
    const bEnd = v.state.doc.content.size - 1;
    const slice = textSlice(".mx\nhttps://b.com.mx", false);
    v.dispatch(v.state.tr.replace(a, bEnd, slice));
    expect(links(v.state)).toEqual([
      { text: "https://a.com.mx", href: "https://a.com.mx", auto: true },
    ]);
  });
});

describe("IME composition", () => {
  it("what is composed inside an autolink waits for the end, then is reconciled in the composition's undo step", () => {
    const v = editor();
    type(v, "https://cafe.com ");
    cut(v);
    const before = v.state.doc;
    caret(v, after(v, "caf"));
    v.dispatch(v.state.tr.delete(v.state.selection.from, v.state.selection.from + 1).setMeta("composition", 7));
    v.dispatch(v.state.tr.insertText("é").setMeta("composition", 7));
    // while composing: untouched (the href waits), the ranges kept
    expect(liveKey.getState(v.state)!.ranges.length).toBeGreaterThan(0);
    const flush = flushLinks(v.state)!;
    expect(flush.getMeta("composition")).toBe(7);
    v.dispatch(flush);
    expect(links(v.state)).toEqual([{ text: "https://café.com", href: "https://café.com", auto: true }]);
    expect(liveKey.getState(v.state)!.ranges).toEqual([]);
    undo(v.state, v.dispatch);
    expect(v.state.doc.eq(before)).toBe(true);
  });

  it("a composition that breaks an autolink: the flush removes the link, and undo puts it back (Codex review)", () => {
    const v = editor();
    type(v, "ver https://x.com fin");
    cut(v);
    const before = v.state.doc;
    // "https" composed over as "ñ": "ñ://x.com" spells nothing
    const from = after(v, "ver ");
    v.dispatch(v.state.tr.insertText("ñ", from, from + 5).setMeta("composition", 3));
    expect(text(v)).toBe("ver ñ://x.com fin");
    v.dispatch(flushLinks(v.state)!);
    expect(links(v.state)).toEqual([]);
    undo(v.state, v.dispatch);
    expect(v.state.doc.eq(before)).toBe(true);
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
  });

  it("an NBSP typed while composing says so (it waits like the rest)", () => {
    const v = editor();
    type(v, "https://x.com ");
    caret(v, after(v, "x.co"));
    type(v, " ", 9);
    // the space went in, and the link hasn't been split yet: the composition isn't over
    expect(text(v)).toBe("https://x.co m ");
    expect(liveKey.getState(v.state)!.composition).toBe(9);
    v.dispatch(flushLinks(v.state)!);
    expect(links(v.state)).toEqual([{ text: "https://x.co", href: "https://x.co", auto: true }]);
  });
});

describe("Codex code review", () => {
  it("an autolink longer than the window (from a forged paste): typing near its start ends, and it is unlinked", () => {
    const url = `https://x.com/${"a".repeat(20_000)}`;
    // (not through the stand-in view: its invariant check refuses such a link before any edit)
    const doc = nodes.doc.create(null, [p("ver ", t(url, auto(url)))]);
    let state = EditorState.create({ doc, plugins });
    state = state.apply(state.tr.insertText("y", 1 + "ver https://x".length));
    expect(links(state)).toEqual([]);
  });

  it("a line of thousands of links is reconciled in linear time", () => {
    const time = (n: number) => {
      const kids: PMNode[] = [];
      for (let i = 0; i < n; i++) kids.push(t(`https://x.com/${i}`, auto(`https://x.com/${i}`)), schema.text(" "));
      const v = editor(nodes.paragraph.create(null, kids));
      const tr = v.state.tr;
      const t0 = performance.now();
      reconcile(tr, [0, v.state.doc.content.size]);
      const ms = performance.now() - t0;
      expect(tr.steps.length).toBe(0);
      return ms;
    };
    time(500);
    const small = Math.min(time(2000), time(2000));
    const big = Math.min(time(8000), time(8000));
    expect(big).toBeLessThan(300);
    // 4× the links: ~4× the time (it was ~16×)
    expect(big).toBeLessThan(Math.max(small, 2) * 9);
  });

  it("a link made right after a long unbroken word stays, and still follows edits inside it", () => {
    const v = editor(p("a".repeat(9000)));
    applyLink(v, { from: 9001, to: 9001 }, "https://x.com", "https://x.com");
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
    caret(v, after(v, "x.co"));
    type(v, "o");
    expect(links(v.state)).toEqual([{ text: "https://x.coom", href: "https://x.coom", auto: true }]);
  });
});

describe("Codex re-review", () => {
  it("a line of thousands of stale autolinks is put right in one step, in linear time", () => {
    const time = (n: number) => {
      const kids: PMNode[] = [];
      for (let i = 0; i < n; i++) kids.push(t(`https://x.com/${i}`, auto(`https://old.example/${i}`)), schema.text(" "));
      const doc = nodes.doc.create(null, [nodes.paragraph.create(null, kids)]);
      const state = EditorState.create({ doc, plugins });
      const tr = state.tr;
      const t0 = performance.now();
      reconcile(tr, [0, doc.content.size]);
      const ms = performance.now() - t0;
      expect(tr.steps.length).toBe(1);
      const after = state.apply(tr);
      expect(links(after).every((l) => l.href === l.text)).toBe(true);
      return ms;
    };
    time(500);
    const small = Math.min(time(2000), time(2000));
    const big = Math.min(time(8000), time(8000));
    expect(big).toBeLessThan(500);
    expect(big).toBeLessThan(Math.max(small, 2) * 9);
  });

  it("an autolink split by formatting, starting outside the window, is left whole by an edit far along its token", () => {
    const bold = marks.bold.create();
    const v = editor(p(t("https://", auto("https://x.com")), t("x.com", auto("https://x.com"), bold), "a".repeat(10_000)));
    v.dispatch(v.state.tr.insertText("b", 8203));
    expect(links(v.state)).toEqual([{ text: "https://x.com", href: "https://x.com", auto: true }]);
  });

  it("a pasted autolink past the cap is unlinked (not kept as a manual link with its href)", () => {
    const long = `https://x.com/${"a".repeat(9000)}`;
    const v = editor(p("a  b"));
    v.dispatch(v.state.tr.insertText("", 2).replaceWith(2, 2, t(long, auto("https://old.example"))));
    expect(links(v.state)).toEqual([]);
  });

  it("a composition retyping one character thousands of times keeps one pending range", () => {
    let state = EditorState.create({ doc: nodes.doc.create(null, [p("x")]), plugins });
    const t0 = performance.now();
    for (let i = 0; i < 8000; i++) state = state.apply(state.tr.insertText(i % 2 ? "a" : "b", 1, 2).setMeta("composition", 1));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(liveKey.getState(state)!.ranges.length).toBe(2);
  });

  it("the selection inside a link being edited stays where it is (one replace step, positions put back)", () => {
    const v = editor();
    type(v, "ver https://example.com fin");
    caret(v, after(v, "https://exa"));
    type(v, "Z");
    expect(v.state.selection.from).toBe(after(v, "https://exaZ"));
    expect(links(v.state)).toEqual([{ text: "https://exaZmple.com", href: "https://exaZmple.com", auto: true }]);
  });
});

describe("work per keystroke", () => {
  it("typing far from any link reconciles nothing; next to one, one line", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => p(`${i} Hola, te paso las notas de la reunión.`));
    const v = editor(...lines, p(t("https://x.com", auto("https://x.com"))));
    caret(v, 3);
    const before = liveStats.slow;
    type(v, "abc");
    expect(liveStats.slow - before).toBe(0);
    caret(v, v.state.doc.content.size - 1);
    type(v, "/a");
    expect(liveStats.slow - before).toBe(2);
    expect(links(v.state)).toEqual([{ text: "https://x.com/a", href: "https://x.com/a", auto: true }]);
  });
});

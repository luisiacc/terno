// @vitest-environment jsdom
import { readBody } from "@terno/core";
import { schema, toPlainText } from "@terno/richtext";
import { closeHistory, undo } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { bodyText, docRange, textAt } from "./body-text";
import { docOf, newState } from "./editor";
import { fillInto, fillsKey, fillsOf, withFillMeta } from "./fills";

/** Plan 163: the gaps someone left, read from the real editor's blocks and filled through its real plugins. */
const state = (html: string, text = "") => newState(docOf(html, text));
const gapsIn = (s: EditorState) => {
  const b = bodyText(s.doc);
  return readBody(b.text).gaps.map((g) => docRange(b, g.from, g.to));
};
const start = (s: EditorState, run = "r1") => s.apply(withFillMeta(s.tr, { start: { run, gaps: gapsIn(s).filter((g): g is { from: number; to: number } => g !== null) } }));
const commit = (s: EditorState, fills: string[]) => {
  const st = fillsOf(s);
  const chosen = st.gaps.filter((g) => !g.spoiled && fills[g.n - 1]).map((g) => ({ from: g.from, to: g.to, text: fills[g.n - 1]! }));
  const { tr, filled } = fillInto(s.tr, s.doc, chosen);
  let next = s.apply(closeHistory(withFillMeta(tr, { stop: st.run! })));
  next = next.apply(withFillMeta(closeHistory(next.tr), { filled }));
  return next;
};
const tinted = (s: EditorState) => fillsKey.getState(s)!.filled.map((f) => s.doc.textBetween(f.from, f.to));

describe("the body as the editor's blocks read it (Codex review 5)", () => {
  it("a block is a line; a list's markers, a quote's > and a link's address aren't in it; offsets are document places", () => {
    const s = state("<p>Hi <b>Arjun</b>,</p><ul><li><p>see you [day]</p></li></ul><blockquote><p>he said [x]</p></blockquote><p>the <a href=\"https://x.test\">doc</a> at [place]</p>");
    const b = bodyText(s.doc);
    expect(b.text).toBe("Hi Arjun,\nsee you [day]\nhe said [x]\nthe doc at [place]");
    const read = readBody(b.text);
    expect(read.gaps.map((g) => g.text)).toEqual(["[day]", "[x]", "[place]"]);
    const ranges = read.gaps.map((g) => docRange(b, g.from, g.to));
    // nothing inside the quote is a gap
    expect(ranges[1]).toBeNull();
    expect(s.doc.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe("[day]");
    expect(s.doc.textBetween(ranges[2]!.from, ranges[2]!.to)).toBe("[place]");
    expect(textAt(b, ranges[2]!.from)).toBe(read.gaps[2]!.from);
  });

  it("never across a break, an image or two blocks; images are said", () => {
    const s = state("<p>a [da<br>y] and <img src=\"cid:1\" data-cid=\"1\"> b</p><p>[x</p><p>y]</p>");
    const b = bodyText(s.doc);
    expect(b.images).toBe(true);
    expect(readBody(b.text).gaps).toEqual([]);
  });

  it("stops past its limit: a glance at a long draft reads its start", () => {
    const s = state(`<p>${"word ".repeat(10)}</p>`.repeat(5000));
    const b = bodyText(s.doc, 1000);
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBeLessThan(1100);
  });
});

describe("filling the gaps (plan 163)", () => {
  it("fills only the gaps, keeps every other word and the gaps' marks, in one undo step that gives every placeholder back", () => {
    let s = start(state("<p>Hi Arjun, the address is <b>[address from his last mail]</b>, see you [day we agreed].</p><p>Luis</p>"));
    s = commit(s, ["Calle Durango 123", "Friday"]);
    expect(toPlainText(s.doc)).toBe("Hi Arjun, the address is Calle Durango 123, see you Friday.\nLuis");
    expect(s.doc.nodeAt(s.doc.textContent.indexOf("Calle") + 1)?.marks.map((m) => m.type.name)).toEqual(["bold"]);
    expect(tinted(s)).toEqual(["Calle Durango 123", "Friday"]);
    undo(s, (tr) => { s = s.apply(tr); });
    expect(toPlainText(s.doc)).toBe("Hi Arjun, the address is [address from his last mail], see you [day we agreed].\nLuis");
    expect(tinted(s)).toEqual([]);
  });

  it("typing elsewhere while it fills goes on, and the fills still land in their gaps", () => {
    let s = start(state("<p>Hi Arjun, see you [day].</p>"));
    s = s.apply(s.tr.insertText("Hello and ", 1));
    s = s.apply(s.tr.insertText(" Bye.", s.doc.content.size - 1));
    s = commit(s, ["Friday"]);
    expect(toPlainText(s.doc)).toBe("Hello and Hi Arjun, see you Friday. Bye.");
  });

  it("a gap typed into is spoiled for good, even when the same words come back (Codex review 7)", () => {
    let s = start(state("<p>Hi Arjun, see you [day] at [place].</p>"));
    const g = fillsOf(s).gaps[0]!;
    s = s.apply(s.tr.insertText("x", g.from + 2));
    s = s.apply(s.tr.delete(g.from + 2, g.from + 3));
    expect(fillsOf(s).gaps.map((x) => x.spoiled)).toEqual([true, false]);
    s = commit(s, ["Friday", "the flat"]);
    expect(toPlainText(s.doc)).toBe("Hi Arjun, see you [day] at the flat.");
  });

  it("the stream shows in place as a decoration, never in the document", () => {
    let s = start(state("<p>Hi Arjun, see you [day].</p>"));
    s = s.apply(withFillMeta(s.tr, { stream: { run: "r1", n: 1, text: "Fri", done: false } }));
    expect(toPlainText(s.doc)).toBe("Hi Arjun, see you [day].");
    const decos = fillsKey.getState(s)!.set.find();
    expect(decos.length).toBe(2);
    expect(fillsOf(s).gaps[0]).toMatchObject({ text: "Fri", done: false });
    // another run's events are ignored
    s = s.apply(withFillMeta(s.tr, { stream: { run: "old", n: 1, text: "Monday", done: true } }));
    expect(fillsOf(s).gaps[0]).toMatchObject({ text: "Fri", done: false });
  });

  it("a fill edited inside loses its tint; nothing to do, no work, without a fill", () => {
    let s = commit(start(state("<p>Hi, see you [day].</p>")), ["Friday"]);
    const [f] = fillsKey.getState(s)!.filled;
    s = s.apply(s.tr.insertText("!", f!.from + 3));
    expect(tinted(s)).toEqual([]);
    const plain = state("<p>Hi</p>");
    const next = plain.apply(plain.tr.insertText("x", 1));
    expect(fillsKey.getState(next)).toBe(fillsKey.getState(plain));
    expect(schema.nodes.paragraph).toBeDefined();
  });
});

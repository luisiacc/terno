/** Reconciling a line of thousands of autolinks stays linear (plan 39). Timed alone: under the parallel unit stage the ratio is noise. */
import { schema } from "@terno/richtext";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { expect, it } from "vitest";
import { reconcile } from "./autolink";
import { createPlugins } from "./editor";

const { marks, nodes } = schema;
const plugins = createPlugins();
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const auto = (href: string) => marks.link.create({ href, auto: true });
const line = (n: number, href: (i: number) => string) => {
  const kids: PMNode[] = [];
  for (let i = 0; i < n; i++) kids.push(t(`https://x.com/${i}`, auto(href(i))), schema.text(" "));
  return EditorState.create({ doc: nodes.doc.create(null, [nodes.paragraph.create(null, kids)]), plugins });
};
const hrefs = (state: EditorState) => {
  const out: { text: string; href: string }[] = [];
  state.doc.descendants((node) => { const link = node.marks.find((m) => m.type === marks.link); if (link) out.push({ text: node.text!, href: link.attrs.href as string }); return true; });
  return out;
};

it("a line of thousands of links is reconciled in linear time", () => {
  const time = (n: number) => {
    const state = line(n, (i) => `https://x.com/${i}`), tr = state.tr;
    const t0 = performance.now();
    reconcile(tr, [0, state.doc.content.size]);
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

it("a line of thousands of stale autolinks is put right in one step, in linear time", () => {
  const time = (n: number) => {
    const state = line(n, (i) => `https://old.example/${i}`), tr = state.tr;
    const t0 = performance.now();
    reconcile(tr, [0, state.doc.content.size]);
    const ms = performance.now() - t0;
    expect(tr.steps.length).toBe(1);
    expect(hrefs(state.apply(tr)).every((l) => l.href === l.text)).toBe(true);
    return ms;
  };
  time(500);
  const small = Math.min(time(2000), time(2000));
  const big = Math.min(time(8000), time(8000));
  expect(big).toBeLessThan(500);
  expect(big).toBeLessThan(Math.max(small, 2) * 9);
});

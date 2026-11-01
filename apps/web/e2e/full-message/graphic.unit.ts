import { expect, it } from "vitest";
import { copyMailTree } from "../../src/components/mail-graphic";

it("yields graphic expansion in batches of at most 64 shallow node copies", async () => {
  const source = document.createElement("template");
  source.innerHTML = '<svg>' + '<path d="M0 0h10v10z"></path>'.repeat(129) + '<text>Complete label 😀</text></svg>';
  const target = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const batches: number[] = [];
  const observer = new MutationObserver((records) => batches.push(records.reduce((count, record) => count + record.addedNodes.length, 0)));
  observer.observe(target, { childList: true, subtree: true });
  try { await copyMailTree(source.content.firstChild!, target, new AbortController().signal); }
  finally { observer.disconnect(); }
  expect(batches.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...batches)).toBeLessThanOrEqual(64);
  expect(target.querySelectorAll("path")).toHaveLength(129);
  expect(target.textContent).toBe("Complete label 😀");
});

it("preserves surrogate pairs when staged source text crosses the copy boundary", async () => {
  const { prepareMailDisplay } = await import("../../src/components/mail-graphic");
  const { mailSections } = await import("../../src/components/mail-sections");
  const source = document.createElement("div");
  const text = 'a'.repeat(4095) + '😀' + 'z'.repeat(4096);
  source.textContent = text;
  const display = await prepareMailDisplay({ root: source, tabs: new WeakMap() }, new AbortController().signal);
  const sections = mailSections(display.root);
  const parts = Array.from({ length: sections.count }, (_, i) => { const template = document.createElement("template"); template.innerHTML = sections.html(i); return template.content.textContent!; });
  expect(parts.join("")).toBe(text);
  for (const part of parts) expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
});

it("cancels a staged graphic without finishing or mutating the source", async () => {
  const source = document.createElement("template");
  source.innerHTML = '<svg>' + '<path d="M0 0h10v10z"></path>'.repeat(129) + '</svg>';
  const target = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const cancellation = new AbortController();
  const observer = new MutationObserver(() => cancellation.abort());
  observer.observe(target, { childList: true });
  try { await expect(copyMailTree(source.content.firstChild!, target, cancellation.signal)).rejects.toMatchObject({ name: "AbortError" }); }
  finally { observer.disconnect(); }
  expect(target.querySelectorAll("path")).toHaveLength(64);
  expect(source.content.querySelectorAll("path")).toHaveLength(129);
});

it("keeps sender marker attributes from cutting off graphic paint ancestry", async () => {
  const { prepareMailDisplay } = await import("../../src/components/mail-graphic");
  const source = document.createElement("div");
  source.innerHTML = '<div data-terno-flow style="color:lime"><svg><rect width="10" height="10" fill="currentColor"/></svg></div>';
  const display = await prepareMailDisplay({ root: source, tabs: new WeakMap() }, new AbortController().signal);
  expect(display.root.querySelector("svg")!.style.color).toBe("lime");
});

import { expect, it } from "vitest";
import { mailSections } from "../../src/components/mail-sections";
const parsed = (html: string) => { const box = document.createElement("template"); box.innerHTML = html; return box.content; };

it("splits an enormous single text leaf without losing whitespace or surrogate pairs", () => {
  const text = "a".repeat(4095) + "😀\n  " + "word ".repeat(5000);
  const parts = mailSections(`<div><a href="https://example.invalid/">${text}</a></div>`);
  expect(parts.count).toBeGreaterThan(4);
  const bodies = Array.from({ length: parts.count }, (_, i) => parsed(parts.html(i)));
  expect(bodies.map((b) => b.textContent).join("")).toBe(text);
  for (const body of bodies) {
    expect(body.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid/");
    expect(body.textContent!.length).toBeLessThanOrEqual(4096);
    expect(body.textContent).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});
it("keeps every table cell and its ancestor context exactly once", () => {
  const html = `<table><tbody><tr><td>${"first ".repeat(1000)}</td><td><a href="mailto:synthetic@example.invalid">last</a></td></tr></tbody></table>`;
  const parts = mailSections(html);
  const bodies = Array.from({ length: parts.count }, (_, i) => parsed(parts.html(i)));
  expect(bodies.map((b) => b.textContent).join("")).toBe(parsed(html).textContent);
  for (const body of bodies) expect(body.querySelector("table > tbody > tr > td")).not.toBeNull();
  expect(bodies.flatMap((b) => [...b.querySelectorAll("a")])).toHaveLength(1);
});
it("keeps empty/image/break payload and SVG as one graphic", () => {
  const html = '<p>First<br><img src="cid:logo" alt="Logo"></p><svg viewBox="0 0 100 100"><text>Graphic label</text></svg><p>Last</p>';
  const parts = mailSections(html);
  const body = parsed(Array.from({ length: parts.count }, (_, i) => parts.html(i)).join(""));
  expect(body.textContent).toBe("FirstGraphic labelLast");
  expect(body.querySelectorAll("svg")).toHaveLength(1);
  expect(body.querySelectorAll("img[src='cid:logo'], br")).toHaveLength(2);
});
it("reflows sender geometry instead of creating another browser-height overflow", () => {
  const parts = mailSections('<div style="height:40000000px!important;line-height:999999px;position:absolute;top:40000000px;transform:scale(999);color:red">Exact text</div>');
  const body = parsed(parts.html(0));
  expect(body.textContent).toBe("Exact text");
  expect(body.querySelector("div")!.getAttribute("style")).toBe("color: red;");
});
it("keeps a sender background image available after geometry reflow", () => {
  const sections = mailSections('<div style="height:99999999px;background-image:url(https://example.invalid/background.png)">Exact background text</div>');
  const body = parsed(sections.html(0));
  expect(body.textContent).toBe("Exact background text");
  expect(body.querySelector("img")?.getAttribute("src")).toBe("https://example.invalid/background.png");
});
it("repeats table headers as context while payload text remains exact", () => {
  const sections = mailSections(`<table><thead><tr><th id="heading">Column</th></tr></thead><tbody><tr><td headers="heading">${"data ".repeat(2000)}</td></tr></tbody></table>`);
  const last = parsed(sections.html(sections.count - 1));
  expect(last.querySelector("table > thead[data-mail-context] th")?.textContent).toBe("Column");
  expect(last.querySelector("td")?.getAttribute("headers")).toBe("heading");
});
it("retains parentheses inside quoted background URLs", () => {
  const sections = mailSections(`<div style='background-image:url("https://example.invalid/bg(a).png")'>Exact</div>`);
  expect(parsed(sections.html(0)).querySelector("img")?.getAttribute("src")).toBe("https://example.invalid/bg(a).png");
});
it("refines around a stable logical payload anchor without omission or duplication", () => {
  const html = Array.from({ length: 130 }, (_, i) => `<p>Row${i}</p>`).join("");
  const coarse = mailSections(html);
  const fine = mailSections(html, 1);
  expect(coarse.offset(1)).toBe(310);
  expect(fine.indexAt(310)).toBe(64);
  expect(parsed(fine.html(64)).textContent).toBe("Row64");
  expect(Array.from({ length: fine.count }, (_, i) => parsed(fine.html(i)).textContent).join("")).toBe(Array.from({ length: 130 }, (_, i) => `Row${i}`).join(""));
});
it("continues ordered list numbering after explicit values and in reversed lists", () => {
  const normal = mailSections(`<ol start="3"><li value="10">${"x".repeat(4096)}</li><li>Next item</li></ol>`);
  expect(parsed(normal.html(1)).querySelector("ol")?.getAttribute("start")).toBe("11");
  const reversed = mailSections(`<ol reversed><li>${"x".repeat(4096)}</li><li>Second</li><li>Third</li></ol>`);
  expect(parsed(reversed.html(1)).querySelector("ol")?.getAttribute("start")).toBe("2");
});

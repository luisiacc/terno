import { expect, it } from "vitest";
import { messageParts } from "./attachments";

// plan 220: which parts a conversation lists as files is read on the render that shows it: linear, whatever the markup
const parts = Array.from({ length: 12 }, (_, i) => ({ id: i, assetId: `a${i}`, contentId: `image${i}@sig`, filename: `image${i}.png`, mime: "image/png", size: 4000 }));
const time = (run: () => void) => { run(); const start = performance.now(); run(); return performance.now() - start; };

it("a long conversation of signed mail: 50 bodies of 200 KB each, scanned once each", () => {
  const signature = parts.map((p) => `<img width="80" alt="logo" src="cid:${p.contentId}">`).join("");
  const body = `<div>${"<p style=\"margin:0\"><span>Texto de la respuesta</span> <a href=\"https://e.test\">enlace</a></p>".repeat(2200)}${signature}</div>`;
  const bodies = Array.from({ length: 50 }, (_, i) => `${body}<!-- ${i} -->`);
  const ms = time(() => { for (const html of bodies) expect(messageParts(html, parts.map((p) => ({ ...p }))).images).toHaveLength(12); });
  expect(ms, "50 bodies of 200 KB").toBeLessThan(150);
});

it("malformed markup stays linear: unterminated tags, comments and raw text", () => {
  for (const html of [`${"<img src=cid:x ".repeat(100_000)}`, `${"<!--<img ".repeat(100_000)}`, `<textarea>${"<img src=cid:x>".repeat(100_000)}`, `${"<p a='>".repeat(100_000)}`]) {
    const ms = time(() => void messageParts(html, parts.map((p) => ({ ...p }))));
    expect(ms, `malformed, ${html.length} characters`).toBeLessThan(60);
  }
});

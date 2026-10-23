import { expect, it } from "vitest";
import { makeSnippet } from "./ingest";

/** The definition: every unquoted line, whitespace collapsed, cut at 200 characters with an ellipsis. */
function reference(text: string | null): string {
  if (!text) return "";
  const collapsed = text.split("\n").filter((line) => !line.trimStart().startsWith(">")).join(" ").replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}

it("makeSnippet reads only what the snippet needs and matches its definition", () => {
  let seed = 5;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pieces = ["hola", "  ", "\n", "\n> citado", "\n   > también citado", "\t", "\r\n", "reunión", "😀", " ", "x".repeat(50), ">", "\n\n", "fin."];
  for (let i = 0; i < 3000; i++) {
    let text = "";
    const n = Math.floor(rand() * 120);
    for (let j = 0; j < n; j++) text += pieces[Math.floor(rand() * pieces.length)];
    expect(makeSnippet(text), JSON.stringify(text)).toBe(reference(text));
  }
  for (const edge of ["", "\n", ">", " \n ", "a".repeat(199), "a".repeat(200), "a".repeat(201), `${"a ".repeat(100)}\n${"b".repeat(400)}`, `${" ".repeat(900)}x`]) {
    expect(makeSnippet(edge)).toBe(reference(edge));
  }
  expect(makeSnippet(null)).toBe("");
});

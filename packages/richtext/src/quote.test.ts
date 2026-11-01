import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeSpaces, lineHtml, MAX_QUOTE_DEPTH, QUOTE_STYLE, textToHtml, textToHtmlChunks } from "./quote";

function* boundaryCases(): Generator<[number, string]> {
  for (const budget of [7, 8, 31, 128, 255, 256]) {
    for (const pad of [0, 1, budget - 2, budget - 1, budget, budget + 1, 2 * budget]) {
      for (const tail of ["", " ", "  ", "\t", "😀é", " https://e.com/path  fin", "https://example.com/" + "x".repeat(budget), '<>&"']) {
        for (const prefix of ["", ">", ">\t", ">  >", ">".repeat(31), "> ".repeat(32), ">".repeat(33)]) {
          yield [budget, prefix + "x".repeat(pad) + tail + "\r\n> next\r\n\rfinal\n"];
        }
      }
    }
  }
}

describe("quote conversion work", () => {
  it("does not invoke replacement callbacks for ordinary isolated spaces", () => {
    const nativeReplace = String.prototype.replace;
    let callbacks = 0;
    let pieces: string[];
    const spy = vi.spyOn(String.prototype, "replace").mockImplementation(function (this: string, pattern, replacement) {
      if (typeof replacement !== "function") return nativeReplace.call(this, pattern, replacement);
      return nativeReplace.call(this, pattern, (...args) => {
        callbacks++;
        return replacement(...args);
      });
    });
    try {
      pieces = [...textToHtmlChunks("x x x x x x x x x x x x ", 8)];
    } finally {
      spy.mockRestore();
    }
    expect(pieces).toEqual(["<div>x x x x ", "x x x x ", "x x x x&nbsp;</div>", ""]);
    expect(pieces.join("")).toBe("<div>x x x x x x x x x x x x&nbsp;</div>");
    expect(callbacks).toBeLessThanOrEqual(1);
  });

  it("keeps literal edge-space state, alternation and tabs", () => {
    const cases: [string, boolean, boolean, boolean, string][] = [
      ["", true, true, true, ""],
      [" ", false, false, false, " "],
      [" ", false, false, true, "&nbsp;"],
      [" ", true, true, true, "&nbsp;"],
      [" x ", false, false, false, " x "],
      [" x ", true, true, false, "&nbsp;x&nbsp;"],
      [" x ", false, false, true, "&nbsp;x "],
      ["x y", true, true, true, "x y"],
      ["  ", false, false, false, " &nbsp;"],
      ["  ", true, true, true, "&nbsp;&nbsp;"],
      ["   ", true, false, true, "&nbsp; &nbsp;"],
      ["   ", false, true, true, "&nbsp; &nbsp;"],
      ["x  y   z", true, true, true, "x &nbsp;y &nbsp; z"],
      ["&amp; &lt; &gt; &quot;", true, true, false, "&amp; &lt; &gt; &quot;"],
      [" \t ", true, true, false, '&nbsp;<span style="white-space:pre">\t</span>&nbsp;'],
    ];
    for (const [input, start, end, after, html] of cases) expect(encodeSpaces(input, start, end, after), JSON.stringify([input, start, end, after])).toBe(html);
    expect(lineHtml(' a & <b> "c" https://e.com/x  fin ')).toBe(
      '&nbsp;a &amp; &lt;b&gt; &quot;c&quot; <a href="https://e.com/x">https://e.com/x</a> &nbsp;fin&nbsp;',
    );
    expect([...textToHtmlChunks("x  y   z ", 8)]).toEqual(["<div>x &nbsp;y &nbsp; z", "&nbsp;</div>"]);
  });

  it("bounds character reads before every yield, including scanning a newline-free line", () => {
    const budget = 256;
    for (const text of ["x ".repeat(4096), `${"> ".repeat(MAX_QUOTE_DEPTH)}\n`.repeat(128)]) {
      let reads = 0;
      let longestSlice = 0;
      // Count input reads without a wall-clock oracle or altering the converter.
      const input = new Proxy({ length: text.length, slice: (start: number, end = text.length) => {
        longestSlice = Math.max(longestSlice, end - start);
        return text.slice(start, end);
      } }, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            reads++;
            return text[Number(key)];
          }
          return Reflect.get(target, key, receiver);
        },
      }) as unknown as string;
      const iterator = textToHtmlChunks(input, budget);
      const pieces: string[] = [];
      for (;;) {
        reads = 0;
        longestSlice = 0;
        const result = iterator.next();
        expect(reads).toBeLessThanOrEqual(4 * budget + 256);
        expect(longestSlice).toBeLessThanOrEqual(budget + 1);
        if (result.done) break;
        pieces.push(result.value);
      }
      expect(pieces.join("")).toBe(textToHtml(text));
    }
  });

  it("keeps exact HTML across scan boundaries, newlines, hostile prefixes and Unicode", () => {
    for (const budget of [128, 256]) {
      for (const pad of [budget - 2, budget - 1, budget, budget + 1]) {
        for (const ending of ["", "\n", "\r", "\r\n"]) {
          const line = `${"x".repeat(pad)} 😀 é <>&"\t  fin`;
          const text = `${line}${ending}`;
          expect([...textToHtmlChunks(text, budget)].join("")).toBe(`<div>${lineHtml(line)}</div>${ending ? "<div><br></div>" : ""}`);
        }
      }
      const line = `${"> ".repeat(MAX_QUOTE_DEPTH + 2)}hola`;
      expect([...textToHtmlChunks(line, budget)].join("")).toBe(
        `<blockquote style="${QUOTE_STYLE}">`.repeat(MAX_QUOTE_DEPTH) + `<div>${lineHtml("> > hola")}</div>` + "</blockquote>".repeat(MAX_QUOTE_DEPTH),
      );
    }
  });

  it("matches the prepared base's exact HTML for 2,352 cut and prefix boundary cases", () => {
    const hash = createHash("sha256");
    for (const [budget, text] of boundaryCases()) hash.update(JSON.stringify([...textToHtmlChunks(text, budget)].join("")));
    // Frozen on 1a8f21f, before the streaming scan change; includes existing long-token seam behavior.
    expect(hash.digest("hex")).toBe("30db5ed02c393e7860b1e8597813214addecf5611c3408aee85f491051446d9e");
  });

  it("can abandon a partially converted quote without affecting another iterator", () => {
    const iterator = textToHtmlChunks("> words ".repeat(1024), 256);
    expect(iterator.next().done).toBe(false);
    iterator.return("");
    expect(iterator.next().done).toBe(true);
    expect(textToHtml("> next")).toBe(`<blockquote style="${QUOTE_STYLE}"><div>next</div></blockquote>`);
  });
});

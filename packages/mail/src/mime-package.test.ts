import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { eachMapping, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import PostalMime, { addressParser, decodeWords } from "postal-mime";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const source = "From: Sender <sender@example.test>\r\nSubject: CommonJS\r\nContent-Type: text/plain\r\n\r\nUseful body";

describe("PostalMime public package entries", () => {
  it("supports the direct CommonJS static parse API", async () => {
    const CommonJS: typeof PostalMime = require("postal-mime");
    expect(await CommonJS.parse(source)).toMatchObject({ subject: "CommonJS", text: "Useful body\n" });
  });

  it("supports the direct CommonJS constructor API", async () => {
    const CommonJS: typeof PostalMime = require("postal-mime");
    expect(await new CommonJS().parse(source)).toMatchObject({ subject: "CommonJS", text: "Useful body\n" });
  });

  it("keeps named helpers and self-default interop on the exported class", () => {
    const CommonJS: typeof PostalMime & { default: typeof PostalMime; addressParser: typeof addressParser; decodeWords: typeof decodeWords } = require("postal-mime");
    expect(typeof CommonJS).toBe("function");
    expect(CommonJS.default).toBe(CommonJS);
    expect(Object.getOwnPropertyDescriptor(CommonJS, "default")).toMatchObject({ enumerable: false, writable: true, configurable: true });
    expect(Object.getOwnPropertyDescriptor(CommonJS, "__esModule")).toEqual({ value: true, enumerable: false, writable: false, configurable: false });
    for (const name of ["addressParser", "decodeWords"] as const) {
      expect(Object.getOwnPropertyDescriptor(CommonJS, name)).toEqual({ value: CommonJS[name], writable: true, enumerable: true, configurable: true });
    }
    expect(CommonJS.decodeWords("=?UTF-8?Q?caf=C3=A9?=")).toBe("café");
    expect(CommonJS.addressParser("Sender <sender@example.test>")).toEqual(addressParser("Sender <sender@example.test>"));
  });
});

const packageRoot = resolve(dirname(require.resolve("postal-mime")), "../..");
describe.each(["esm", "cjs"])("PostalMime %s declaration map", (format) => {
  const declarationPath = join(packageRoot, "dist", format, "postal-mime.d.ts");
  const declaration = readFileSync(declarationPath, "utf8").split("\n");
  const original = readFileSync(join(packageRoot, "src/postal-mime.ts"), "utf8").split("\n");
  const map = new TraceMap(JSON.parse(readFileSync(`${declarationPath}.map`, "utf8")));

  it("maps only valid generated and original positions", () => {
    eachMapping(map, (mapping) => {
      expect(mapping.generatedLine).toBeGreaterThan(0);
      expect(mapping.generatedColumn).toBeLessThanOrEqual(declaration[mapping.generatedLine - 1]!.length);
      if (mapping.originalLine !== null && mapping.originalColumn !== null) {
        expect(mapping.source).toBe("../../src/postal-mime.ts");
        expect(mapping.originalLine).toBeGreaterThan(0);
        expect(mapping.originalColumn).toBeLessThanOrEqual(original[mapping.originalLine - 1]!.length);
      }
    });
  });

  if (format === "cjs") it("leaves the custom namespace and export assignment unmapped", () => {
    for (const anchor of ["declare namespace PostalMime", "export = PostalMime"]) {
      const line = declaration.findIndex((text) => text.startsWith(anchor));
      expect(line).toBeGreaterThanOrEqual(0);
      expect(originalPositionFor(map, { line: line + 1, column: 0 }).source).toBeNull();
    }
  });

  it.each([
    ["import type", "Email"],
    ["class PostalMime", "PostalMime"],
    ["static parse(", "parse"],
    ["constructor(", "options"],
    ["    parse(", "parse"],
  ])("maps %s to its current source declaration", (anchor, token) => {
    const generatedLine = declaration.findIndex((line) => line.includes(anchor));
    expect(generatedLine).toBeGreaterThanOrEqual(0);
    const position = originalPositionFor(map, { line: generatedLine + 1, column: declaration[generatedLine]!.indexOf(token) });
    expect(position.source).toBe("../../src/postal-mime.ts");
    expect(position.line).not.toBeNull();
    expect(position.column).not.toBeNull();
    expect(original[position.line! - 1]!.slice(position.column!, position.column! + token.length)).toBe(token);
    expect(original[position.line! - 1]).toContain(anchor === "static parse(" ? "static async parse(" : anchor === "    parse(" ? "async parse(" : anchor);
  });
});

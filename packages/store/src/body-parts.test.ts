import { expect, it } from "vitest";
import { assembleBody, encodeBodyPart, matchBodyParts, type BodyPartSource } from "./body-parts";

function source(parts: string[]): BodyPartSource {
  return { async read(after) { const value = parts[after + 1]; return value === undefined ? null : { ordinal: after + 1, value: encodeBodyPart(value) }; } };
}

it("reads exact UTF16 including split surrogates, combining marks, NUL and CRLF", async () => {
  expect(await assembleBody(source(["\ud83d", "\ude00e", "\u0301\r", "\n\0<p>", "\ud800"]))).toBe("😀e\u0301\r\n\0<p>\ud800");
});

it("matches complete phrases and anchored words across token and storage boundaries", async () => {
  const body = () => source(["\0alp", "ha\0e", "cole\0b", "eta\0"]);
  expect(await matchBodyParts(body(), "contains", "ÉCOLE beta")).toBe(true);
  expect(await matchBodyParts(body(), "contains", "alpha beta")).toBe(false);
  expect(await matchBodyParts(body(), "startsWith", "alpha ecole")).toBe(true);
  expect(await matchBodyParts(body(), "startsWith", "ecole")).toBe(false);
  expect(await matchBodyParts(body(), "endsWith", "ecole beta")).toBe(true);
  expect(await matchBodyParts(body(), "endsWith", "alpha ecole")).toBe(false);
  expect(await matchBodyParts(body(), "equals", "alpha ecole beta")).toBe(true);
  expect(await matchBodyParts(body(), "equals", "alpha")).toBe(false);
  expect(await matchBodyParts(body(), "contains", "ecole be", true)).toBe(true);
  expect(await matchBodyParts(body(), "contains", "ecole be")).toBe(false);
});

it("does not turn a long token prefix into an exact word or a phrase across two messages", async () => {
  const word = "x".repeat(32768);
  expect(await matchBodyParts(source(["\0" + word.slice(1), "x\0tail\0"]), "contains", "xxx")).toBe(false);
  expect(await matchBodyParts(source(["\0" + word.slice(1), "x\0tail\0"]), "contains", "xxx", true)).toBe(true);
  expect(await matchBodyParts(source(["\0alpha\0"]), "contains", "alpha beta")).toBe(false);
});

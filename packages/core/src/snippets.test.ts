import { describe, expect, it } from "vitest";
import { fillText, findVariables, nameParts, snippetFieldsSchema, snippetPreview } from "./snippets";

describe("snippet variables", () => {
  const values = { first_name: "Ana", last_name: "García", email: "ana@x.com", my_name: "Luis" };

  it("fill any case and spaces inside the braces; other words stay text", () => {
    expect(fillText("Hi {first_name}, {FIRST_NAME} { First_Name } {name} {cursor}", values)).toBe("Hi Ana, Ana Ana {name} {cursor}");
  });

  it("leave a variable without a value as written", () => {
    expect(fillText("Dear {first_name} {full_name}", { first_name: "  " })).toBe("Dear {first_name} {full_name}");
  });

  it("are found with their place and value", () => {
    expect(findVariables("a {email} b {my_first_name}", values)).toEqual([
      { from: 2, to: 9, name: "email", value: "ana@x.com" },
      { from: 12, to: 27, name: "my_first_name", value: null },
    ]);
  });
});

describe("nameParts", () => {
  it("splits a display name, and 'Last, First'", () => {
    expect(nameParts("Ana García López")).toEqual({ first: "Ana", last: "García López", full: "Ana García López" });
    expect(nameParts('"García, Ana"')).toEqual({ first: "Ana", last: "García", full: "Ana García" });
    expect(nameParts("Cher")).toEqual({ first: "Cher", last: "", full: "Cher" });
  });

  it("never guesses from an address or nothing", () => {
    expect(nameParts("ana@x.com")).toBeNull();
    expect(nameParts("")).toBeNull();
    expect(nameParts(undefined)).toBeNull();
  });
});

it("previews the first line that has text", () => {
  expect(snippetPreview({ bodyText: "\n\n  Hello there\nmore" })).toBe("Hello there");
  expect(snippetPreview({ bodyText: "x".repeat(200) }, 10)).toBe(`${"x".repeat(9)}…`);
});

it("refuses images in a snippet's HTML", () => {
  const base = { name: "", bodyText: "", subject: "", to: "", cc: "", bcc: "" };
  expect(snippetFieldsSchema.safeParse({ ...base, bodyHtml: "<p>hi</p>" }).success).toBe(true);
  expect(snippetFieldsSchema.safeParse({ ...base, bodyHtml: '<p><IMG src="cid:a"></p>' }).success).toBe(false);
});

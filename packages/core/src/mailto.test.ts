import { describe, expect, it } from "vitest";
import { mailtoLink } from "./mailto";

/** Plan 284: a mailto link as the reader's menu writes to it. Plan 96's defaults are `unsubscribe.test.ts`'s. */
describe("mailtoLink", () => {
  it("is one address, with the subject and body it gives and nothing where it gives none", () => {
    expect(mailtoLink("mailto:casasupport@tacsecurity.example")).toEqual({ to: "casasupport@tacsecurity.example", subject: "", body: "" });
    expect(mailtoLink("MAILTO:Ana%40x.example?Subject=Hola%20Ana&body=1%2B1")).toEqual({ to: "Ana@x.example", subject: "Hola Ana", body: "1+1" });
  });

  it("is nobody it can't write to alone: several, none, someone else in a to field, a broken escape", () => {
    for (const uri of ["mailto:a@x.example,b@x.example", "mailto:", "mailto:?subject=hi", "mailto:a@x.example?to=b@x.example", "mailto:not-an-address", "mailto:a@x.example?subject=%E0%A4%A", "https://x.example"]) expect(mailtoLink(uri)).toBeNull();
  });

  it("leaves a fragment out, and reads an encoded # as one", () => {
    expect(mailtoLink("mailto:a@x.example?subject=Hello#footer")!.subject).toBe("Hello");
    expect(mailtoLink("mailto:a@x.example#footer")!.to).toBe("a@x.example");
    expect(mailtoLink("mailto:a@x.example?subject=Order%20%2342")!.subject).toBe("Order #42");
  });
});

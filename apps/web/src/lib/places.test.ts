import { describe, expect, it } from "vitest";
import { actionView, placeOf } from "./places";

const row = (inInbox: boolean, inSpam = false, inTrash = false) => ({ inInbox, inSpam, inTrash });

describe("actions follow the rows' places in a search (plan 64)", () => {
  it("outside a search: the sidebar's view", () => {
    expect(actionView("inbox", "", [row(false, false, true)])).toBe("inbox");
  });
  it("a search: the place every row shares, else all; in:… says it", () => {
    expect(actionView("inbox", "factura", [row(false, false, true)])).toBe("trash");
    expect(actionView("inbox", "factura", [row(false, true), row(false, true)])).toBe("spam");
    expect(actionView("spam", "factura", [row(false)])).toBe("archive");
    expect(actionView("trash", "factura", [row(true)])).toBe("inbox");
    expect(actionView("inbox", "factura", [row(true), row(false, true)])).toBe("all");
    expect(actionView("inbox", "in:spam factura", [row(true)])).toBe("spam");
    // unknown places (an older backend, or a "select all N" scope): every action
    expect(actionView("inbox", "factura", [])).toBe("all");
    expect(actionView("inbox", "factura", [{ inInbox: undefined, inSpam: undefined, inTrash: undefined }])).toBe("all");
  });
  it("trash wins over spam", () => {
    expect(placeOf(row(false, true, true))).toBe("trash");
  });
});

import { contentTokens } from "@unica/core";
import { describe, expect, it } from "vitest";
import { testDb } from "./test/helpers";

describe("categorization features vs the FTS index", () => {
  it("content tokens are the FTS tokens (diacritics, case, scripts), so explanations and search agree", () => {
    const db = testDb();
    db.exec("CREATE VIRTUAL TABLE tok USING fts5(x, tokenize = 'unicode61 remove_diacritics 2')");
    db.exec("CREATE VIRTUAL TABLE tok_v USING fts5vocab(tok, 'instance')");
    const text = "Facturación ÁRBOL niño Ünïcödé São-Paulo e-mail café Ελληνικά кириллица";
    db.run("INSERT INTO tok (x) VALUES (?)", text);
    const fts = db.all<{ term: string }>("SELECT term FROM tok_v ORDER BY offset").map((r) => r.term);
    expect(fts).toContain("facturacion");
    expect(contentTokens(text)).toEqual(fts.filter((t) => t.length > 1));
  });
});

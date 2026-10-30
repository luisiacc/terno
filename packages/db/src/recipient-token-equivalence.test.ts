import { expect, it } from "vitest";
import { testDb } from "./test/helpers";

it("SQLite tokenizer reconstruction preserves recipient tokens, positions, phrases and rank", () => {
  const db = testDb();
  db.exec(`CREATE VIRTUAL TABLE temp.recipient_raw USING fts5(value, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE temp.recipient_raw_vocab USING fts5vocab(recipient_raw, 'instance');
    CREATE VIRTUAL TABLE temp.recipient_prepared USING fts5(value, tokenize = 'unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE temp.recipient_prepared_vocab USING fts5vocab(recipient_prepared, 'instance');`);
  const pieces = ["Éxample niñO 名字 ภาษาไทย Ελληνικά ςΣ ﬀ Ⅳ ① à\u0301", "İıẞK ﬁ Œ ø æ ǅ 𝔸 🏳️‍🌈 foo+tag@example.test", "a\u0301b\u034fcd ab.cd A_B 0️⃣ Test", "a\0b it's can't € 𐐀 𞤀 a-b c_d"];
  const tokens = (vocab: string, id: number) => db.all<{ term: string; offset: number }>(`SELECT term,offset FROM temp.${vocab} WHERE doc=? ORDER BY offset`, id);
  const prepared: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    db.run("INSERT INTO temp.recipient_raw(rowid,value) VALUES(?,?)", index + 1, piece);
    const input = tokens("recipient_raw_vocab", index + 1), text = input.map((entry) => entry.term).join(" ");
    db.run("INSERT INTO temp.recipient_prepared(rowid,value) VALUES(?,?)", index + 1, text);
    expect(tokens("recipient_prepared_vocab", index + 1)).toEqual(input);
    prepared.push(text);
  }
  const id = pieces.length + 1;
  db.run("INSERT INTO temp.recipient_raw(rowid,value) VALUES(?,?)", id, pieces.join(" "));
  db.run("INSERT INTO temp.recipient_prepared(rowid,value) VALUES(?,?)", id, prepared.join(" "));
  expect(tokens("recipient_prepared_vocab", id)).toEqual(tokens("recipient_raw_vocab", id));
  for (const expression of ['"example nino"', '"foo tag"', '"test a"', '"example"*', '"ελληνικά"']) {
    const raw = db.get<{ score: number }>("SELECT bm25(recipient_raw) AS score FROM temp.recipient_raw WHERE recipient_raw MATCH ? AND rowid=?", expression, id);
    const built = db.get<{ score: number }>("SELECT bm25(recipient_prepared) AS score FROM temp.recipient_prepared WHERE recipient_prepared MATCH ? AND rowid=?", expression, id);
    expect(built).toEqual(raw);
  }
});

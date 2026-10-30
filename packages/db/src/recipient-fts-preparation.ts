import { addressKey, type Address } from "@terno/core";
import type { Db } from "./sqlite";

let nextPreparation = 0;

/** Use SQLite's own tokenizer; round-trip each bounded piece before substituting it. */
export async function prepareRecipientFts(db: Db, fields: { to: Address[]; cc: Address[]; bcc: Address[] }, yieldTo: () => Promise<void>): Promise<string | undefined> {
  const entries = [...fields.to, ...fields.cc, ...fields.bcc];
  if (entries.length < 64) return undefined;
  const suffix = ++nextPreparation;
  const tokens = `terno_recipient_tokens_${suffix}`, vocab = `terno_recipient_vocab_${suffix}`;
  db.exec(`CREATE VIRTUAL TABLE temp.${tokens} USING fts5(value, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE temp.${vocab} USING fts5vocab(${tokens}, 'instance');`);
  const pieces: string[] = [];
  const tokenize = (text: string) => {
    db.run(`INSERT INTO temp.${tokens}(rowid,value) VALUES(1,?)`, text);
    try { return db.all<{ term: string; offset: number }>(`SELECT term,offset FROM temp.${vocab} WHERE doc=1 ORDER BY offset`); }
    finally { db.run(`DELETE FROM temp.${tokens} WHERE rowid=1`); }
  };
  try {
    for (let offset = 0; offset < entries.length; offset += 8) {
      const text = entries.slice(offset, offset + 8).map((entry) => entry.name ? `${entry.name} ${entry.email}` : entry.email).join(" ");
      const original = tokenize(text), candidate = original.map((token) => token.term).join(" "), again = tokenize(candidate);
      pieces.push(original.length === again.length && original.every((token, index) => token.term === again[index]?.term && token.offset === again[index]?.offset) ? candidate : text);
      await yieldTo();
    }
    return pieces.join(" ");
  } finally { db.exec(`DROP TABLE temp.${vocab}; DROP TABLE temp.${tokens};`); }
}

export async function prepareRecipientCorrespondents(fields: { to: Address[]; cc: Address[]; bcc: Address[] }, yieldTo: () => Promise<void>): Promise<string[][] | undefined> {
  const entries = [...fields.to, ...fields.cc, ...fields.bcc];
  if (entries.length < 64) return undefined;
  const seen = new Set<string>(), chunks: string[][] = [];
  let current: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const key = addressKey(entries[index]!.email);
    if (key.includes("@") && !seen.has(key)) {
      seen.add(key); current.push(key);
      if (current.length === 64) { chunks.push(current); current = []; }
    }
    if ((index + 1) % 32 === 0) await yieldTo();
  }
  if (current.length) chunks.push(current);
  return chunks;
}

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { sqlDb } from "@terno/db";
import { Backend, plaintextCipher } from "./backend";
import { incomingGmailFixture } from "./incoming-gmail-fixture";

it("persists an emitted small complete body without multi-transaction capture staging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-small-body-"));
  const text = "Exact 😀 small body\r\n", html = "<p>Exact 🧡 small HTML</p>";
  const raw = ["MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=b", "", "--b", "Content-Type: text/plain; charset=utf-8", "", text, "--b", "Content-Type: text/html; charset=utf-8", "", html, "--b--", ""].join("\r\n");
  const fixture = incomingGmailFixture({ ids: ["small"], raw: () => Response.json({ id: "small", threadId: "small", labelIds: ["INBOX"], raw: Buffer.from(raw).toString("base64url") }) });
  const providers: ProviderRegistry = { create: (ctx) => createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() }), async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); } };
  const backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, version: "test", autoSync: false, instantSearch: false, iconTransport: null });
  try {
    await backend.ready;
    const db = sqlDb(backend.store), run = db.run.bind(db); let captures = 0;
    vi.spyOn(db, "run").mockImplementation((sql, ...args) => { if (sql.startsWith("INSERT INTO body_captures")) captures++; return run(sql, ...args); });
    const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "brown", now: 1 });
    fixture.accounts.set("synthetic", account.email);
    await backend.syncAccount(account.id);
    const rows = (await backend.store.debug.snapshot()).messages;
    const message = (await backend.store.threads.get(rows[0]!.threadId))!.messages[0]!;
    expect(message.bodyText).toBe("Exact 😀 small body\n"); expect(message.bodyHtml).toBe(html);
    expect(fixture.unexpected).toEqual([]);
    expect(captures, "a body already inside one existing storage unit needs no part staging transactions").toBe(0);
  } finally { await backend.stop(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); }
});

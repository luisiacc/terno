import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imapkit from "imapkit";
import { createRegistry } from "@terno/mail";
import { startDevServer } from "../../../../apps/backend-dev/src/server";

export const asset = Buffer.from([0, 255, 19, 128, 10, 13, 42]);
export const body = Array.from({ length: 70 }, (_, i) => `Reader anchor ${String(i).padStart(2, "0")} exact synthetic content`).join("\n");
export function raw(subject: string, text: string, id: string, parent?: string, binary = false) {
  return ["From: Synthetic <sender@example.test>", "To: Synthetic <synthetic@example.test>", `Subject: ${subject}`,
    `Message-ID: <${id}@example.test>`, ...(parent ? [`In-Reply-To: <${parent}@example.test>`, `References: <${parent}@example.test>`] : []),
    "Date: Sat, 31 Oct 2026 12:00:00 +0000", "MIME-Version: 1.0",
    ...(binary ? ['Content-Type: multipart/mixed; boundary="w06"', "", "--w06"] : []),
    'Content-Type: text/plain; charset="utf-8"', "", text.trimEnd(),
    ...(binary ? ["--w06", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="exact.bin"', "Content-Transfer-Encoding: base64", "", asset.toString("base64"), "--w06--"] : []), ""].join("\r\n");
}
export async function readerFixture() {
  const dir = mkdtempSync(join(tmpdir(), "terno-w06-reader-"));
  const wire = imapkit({ plugins: ["MOVE", "UIDPLUS", "SPECIAL-USE", "ENABLE", "CONDSTORE"], storage: { INBOX: {}, "": { separator: "/", folders: { A: {}, Z: {}, Trash: { "special-use": "\\Trash" } } } } });
  const commands: string[] = [];
  wire.script.add({ on: "command", run: true, when(ctx) { if (commands.length >= 2000) throw new Error("command capture overflow"); commands.push(ctx.command!); return false; } });
  let dev: Awaited<ReturnType<typeof startDevServer>> | undefined;
  const open = async () => dev = await startDevServer({ port: 0, dataDir: dir, token: "w06", seed: false, autoSync: false, providers: createRegistry({ imap: { allowInsecure: true } }) });
  try {
    const port = await wire.start(0, "127.0.0.1");
    await open();
    const account = await dev!.backend.server.invoke("accounts.addImap", { email: "synthetic@example.test", displayName: "Synthetic", imap: { host: "127.0.0.1", port, secure: false, user: "testuser" }, smtp: { host: "127.0.0.1", port: 1, secure: false, user: "testuser" }, password: "testpass", verify: false }, { clientId: "w06", origin: "dev" });
    return { wire, commands, account, get dev() { return dev!; }, async reopen() { await dev!.close(); return open(); }, async close() {
      try { await dev!.close(); } finally { try { await wire.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
    } };
  } catch (error) {
    try { await dev?.close(); } finally { try { await wire.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
    throw error;
  }
}

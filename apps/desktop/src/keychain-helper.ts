/**
 * Electron's safeStorage keeps its key in a keychain item named after the app:
 * "<name> Safe Storage" (account "<name> Key"), fixed when the app starts.
 * Secrets saved while the app was called Única open only with "Única Safe
 * Storage", which Terno's process can't select. So main launches this same
 * executable once in helper mode, under the old name: it reads the sealed
 * blobs from stdin, opens what it can and writes the plaintexts to stdout,
 * a pipe only main holds. The backend seals them again under Terno's item and
 * replaces a blob only after the new one opens to the same text
 * (packages/backend/src/keychain.ts). Nothing is deleted, not even the old item.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

export const KEYCHAIN_HELPER_FLAG = "--terno-legacy-keychain";
/** the name Única's secrets are sealed under (tests point both names at throwaway keychain items) */
export const LEGACY_APP_NAME = process.env.TERNO_TEST_LEGACY_APP_NAME ?? "Única";
const RESULT = "TERNO_KEYCHAIN_RESULT ";

/** Helper mode: no window, no profile (a scratch userData), exits as soon as it answered. */
export function runKeychainHelper(): void {
  const name = process.argv.find((a) => a.startsWith("--legacy-name="))?.slice("--legacy-name=".length) || LEGACY_APP_NAME;
  // before ready: Electron derives the keychain item from the name at startup
  app.setName(name);
  const scratch = mkdtempSync(join(tmpdir(), "terno-keychain-"));
  app.setPath("userData", scratch);
  app.disableHardwareAcceleration();
  app.dock?.hide();
  const finish = (values: (string | null)[]) => {
    process.stdout.write(`${RESULT}${JSON.stringify({ values })}\n`, () => {
      rmSync(scratch, { recursive: true, force: true });
      app.exit(0);
    });
  };
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => (input += d));
  process.stdin.on("end", () => {
    void app.whenReady().then(() => {
      let blobs: string[] = [];
      try {
        blobs = (JSON.parse(input) as { blobs: string[] }).blobs;
      } catch {
        return finish([]);
      }
      finish(
        blobs.map((b) => {
          try {
            return safeStorage.decryptString(Buffer.from(b, "base64"));
          } catch {
            return null;
          }
        }),
      );
    });
  });
}

/**
 * Main's side: opens Única's blobs through the helper. One plaintext (or
 * null) per blob; rejects if the helper can't run or doesn't answer in time
 * (macOS may first ask whether Terno may use "Única Safe Storage").
 */
export function readLegacySecrets(blobs: Uint8Array[], options: { legacyName?: string; timeoutMs?: number } = {}): Promise<(string | null)[]> {
  if (blobs.length === 0) return Promise.resolve([]);
  // unpackaged, Electron needs the entry script; a packaged app always runs its own
  const args = [...(app.isPackaged ? [] : [__filename]), KEYCHAIN_HELPER_FLAG, `--legacy-name=${options.legacyName ?? LEGACY_APP_NAME}`];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const done = (error: Error | null, values?: (string | null)[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(values!);
    };
    const timer = setTimeout(() => done(new Error("the keychain helper didn't answer in time")), options.timeoutMs ?? 120_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const at = out.indexOf(RESULT);
      const end = at < 0 ? -1 : out.indexOf("\n", at);
      if (end < 0) return;
      try {
        const { values } = JSON.parse(out.slice(at + RESULT.length, end)) as { values: (string | null)[] };
        done(values.length === blobs.length ? null : new Error("the keychain helper answered for other blobs"), values);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("error", (error) => done(error));
    // "close": after its stdout is drained, so an answer written just before exiting is never missed
    child.on("close", (code) => done(new Error(`the keychain helper exited (${code}) without answering`)));
    child.stdin.end(JSON.stringify({ blobs: blobs.map((b) => Buffer.from(b).toString("base64")) }));
  });
}

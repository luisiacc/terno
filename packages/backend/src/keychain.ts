import type { MailStore } from "@terno/store";

/**
 * Secrets sealed when the app was called Única. On desktop, Electron's
 * safeStorage derives its keychain item from the app name ("Única Safe
 * Storage" then, "Terno Safe Storage" now), so those blobs only open with the
 * old item. The host reads them with a LegacySecretReader (desktop: a one-shot
 * helper process running under the old name) and they are sealed again here.
 * What can't be read stays pending, is reported as unreadable (Settings asks
 * for it again) and is retried on the next start; nothing is dropped.
 */
export const KEYCHAIN_STATE_KEY = "secrets.keychain";
export const KEYCHAIN_GENERATION = "terno";

export interface KeychainState {
  /** the keychain the secrets not listed below are sealed under */
  generation: string;
  /** name → fingerprint of a blob still sealed under the previous keychain; a rewritten secret no longer matches */
  pending: Record<string, string>;
}

/** Opens blobs sealed under the previous keychain: one plaintext per blob, null where it couldn't. */
export type LegacySecretReader = (blobs: Uint8Array[]) => Promise<(string | null)[]>;

export interface SecretSealer {
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(blob: Uint8Array): Promise<string>;
}

/** What a secret is, and where Settings asks for it again. */
export function secretPrompt(name: string): string {
  if (/^account:\d+:password$/.test(name)) return "la contraseña de esta cuenta. Vuelve a introducirla en Ajustes → Cuentas (Cambiar contraseña…)";
  if (/^account:\d+:refreshToken$/.test(name)) return "la sesión de Google de esta cuenta. Vuelve a conectarla en Ajustes → Cuentas (Conectar con Google)";
  if (name === "gmailClientSecret") return "el client secret de Google. Vuelve a guardarlo en Ajustes → Cuentas";
  if (name.startsWith("ai:")) return "tu API key. Vuelve a guardarla en Ajustes → IA";
  return "un secreto guardado. Vuelve a introducirlo en Ajustes";
}

export class SecretUnreadableError extends Error {
  constructor(
    readonly secretName: string,
    /** sealed by Única and not migrated (else: the keychain refused it) */
    readonly legacy: boolean,
  ) {
    super(`${legacy ? "Terno no pudo abrir lo que guardó Única: " : "El llavero no abre "}${secretPrompt(secretName)}.`);
    this.name = "SecretUnreadableError";
  }
}

/** FNV-1a over the blob: tells "still the legacy blob" from "rewritten since" without keeping a copy. */
export function blobFingerprint(blob: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of blob) h = Math.imul(h ^ b, 0x01000193);
  return `${blob.length}:${(h >>> 0).toString(16)}`;
}

/**
 * A decryption under the wrong key can pass the padding check and yield
 * garbage (about 1 in 256 for CBC): a stored password, token or API key is
 * text, so replacement characters or control characters mean "not this key".
 */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const IMPLAUSIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/;
export const plausibleSecret = (plain: string): boolean => plain.length > 0 && !IMPLAUSIBLE.test(plain);

export async function readKeychainState(store: Pick<MailStore, "settings">): Promise<KeychainState | null> {
  return store.settings.get<KeychainState | null>(KEYCHAIN_STATE_KEY, null);
}

/** The names whose stored blob is still the legacy one (secrets entered again since are not). */
export async function unreadableSecrets(store: Pick<MailStore, "settings" | "secrets">): Promise<Set<string>> {
  const state = await readKeychainState(store);
  const names = new Set<string>();
  for (const [name, fingerprint] of Object.entries(state?.pending ?? {})) {
    const blob = await store.secrets.get(name);
    if (blob && blobFingerprint(blob) === fingerprint) names.add(name);
  }
  return names;
}

export interface SecretMigrationResult {
  migrated: string[];
  pending: string[];
  /** the legacy reader ran (false: nothing to migrate) */
  attempted: boolean;
}

/**
 * Seals every legacy secret again under the current keychain. The first start
 * under Terno records every stored secret as pending (all of them were sealed
 * by Única); later starts retry only what is still pending. A secret is
 * replaced only after its new blob decrypts to the same text, and only if
 * nothing rewrote it meanwhile.
 */
export async function migrateLegacySecrets(
  store: MailStore,
  cipher: SecretSealer,
  read: LegacySecretReader,
  log: (level: "info" | "warn", message: string) => void = () => {},
): Promise<SecretMigrationResult> {
  let state = await readKeychainState(store);
  if (!state) {
    const pending: Record<string, string> = {};
    for (const name of await store.secrets.names()) {
      const blob = await store.secrets.get(name);
      if (blob) pending[name] = blobFingerprint(blob);
    }
    state = { generation: KEYCHAIN_GENERATION, pending };
    await store.settings.set(KEYCHAIN_STATE_KEY, state);
  }
  const todo: { name: string; blob: Uint8Array }[] = [];
  for (const [name, fingerprint] of Object.entries(state.pending)) {
    const blob = await store.secrets.get(name);
    if (blob && blobFingerprint(blob) === fingerprint) todo.push({ name, blob });
  }
  const settle = async (done: string[]) => {
    const live = new Set(todo.map((t) => t.name));
    await store.settings.update<KeychainState | null, void>(KEYCHAIN_STATE_KEY, null, (s) => {
      const pending = Object.fromEntries(Object.entries(s?.pending ?? {}).filter(([name]) => live.has(name) && !done.includes(name)));
      return { value: { generation: KEYCHAIN_GENERATION, pending }, result: undefined };
    });
  };
  if (todo.length === 0) {
    if (Object.keys(state.pending).length) await settle([]);
    return { migrated: [], pending: [], attempted: false };
  }

  let plains: (string | null)[];
  try {
    plains = await read(todo.map((t) => t.blob));
  } catch (error) {
    log("warn", `the previous keychain couldn't be read: ${error instanceof Error ? error.message : String(error)}`);
    plains = todo.map(() => null);
  }
  const migrated: string[] = [];
  for (const [i, { name, blob }] of todo.entries()) {
    const plain = plains[i] ?? null;
    if (plain === null || !plausibleSecret(plain)) continue;
    try {
      const sealed = await cipher.encrypt(plain);
      if ((await cipher.decrypt(sealed)) !== plain) throw new Error("the new blob doesn't open to the same text");
      const current = await store.secrets.get(name);
      if (!current || blobFingerprint(current) !== blobFingerprint(blob)) continue;
      await store.secrets.put(name, sealed);
      migrated.push(name);
    } catch (error) {
      log("warn", `secret ${name} kept as it was: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await settle(migrated);
  const pending = todo.map((t) => t.name).filter((n) => !migrated.includes(n));
  log(pending.length ? "warn" : "info", `keychain migration: ${migrated.length} secret(s) sealed again, ${pending.length} to enter again${pending.length ? ` (${pending.join(", ")})` : ""}`);
  return { migrated, pending, attempted: true };
}

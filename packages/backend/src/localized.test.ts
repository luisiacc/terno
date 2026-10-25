/** The backend has no language: what it says to the user goes out as catalog messages the renderer shows in its own. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError } from "@terno/ai";
import { createMemoryTransportPair, RpcClient, toErrorPayload, type RpcError } from "@terno/core/rpc";
import { L, setLocale, translate } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { demoRegistry, ProviderAuthError, ProviderError } from "@terno/mail";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { opSummary } from "./core";
import { loginFailed } from "./identity";
import { SecretUnreadableError } from "./keychain";
import { NetworkPolicyError } from "./net-policy";
import { SettingsError } from "./settings";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  setLocale("en", en);
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A renderer-like client: errors with a catalog key come out in the active locale. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-localized-"));
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client: new RpcClient(c, { translate }) };
}

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);

describe("errors as catalog messages", () => {
  it("every user-facing error class keeps its English message and carries the key to the wire", () => {
    const errors = [
      new SettingsError(L("errors.themeUnknownDark", { id: "x" })),
      new AiError(L("errors.ai.timeout", { provider: "Ollama" }), "timeout"),
      new NetworkPolicyError(L("errors.net.localModeCloudAi", { host: "api.openai.com" }), "ai", "api.openai.com"),
      new ProviderError(L("errors.smtp.authFailed", { detail: "535" }), false),
      new ProviderAuthError(L("errors.gmail.revoked")),
    ];
    for (const e of errors) {
      const payload = toErrorPayload(e);
      expect(payload.message).toBe(e.message);
      expect(payload.i18n).toEqual(e.i18n);
      expect(payload.i18n?.key).toMatch(/^errors\./);
    }
    expect(errors[1]!.message).toBe("Ollama didn’t answer in time.");
    // plain text (a server's own words) has no key
    expect(toErrorPayload(new ProviderError("IMAP: Mailbox is full", true)).i18n).toBeUndefined();
  });

  it("a refused setting reaches the renderer in its language", async () => {
    const { client } = setup();
    await client.call("settings.update", { localMode: true });
    const english = await errorOf(client.call("settings.update", { ai: { provider: "openai", model: "gpt-x" } }));
    expect(english).toMatchObject({ code: "BAD_REQUEST", message: "OpenAI runs in the cloud and local mode is on. Turn it off in Settings → General to use it.", i18n: { key: "errors.cloudAiLocalMode" } });
    setLocale("es", es);
    expect(await errorOf(client.call("settings.update", { lightTheme: "dracula" }))).toMatchObject({ message: "Tema desconocido para el modo claro: dracula" });
    expect(await errorOf(client.call("threads.get", { threadId: 9999 }))).toMatchObject({ code: "NOT_FOUND", message: "Esa conversación ya no existe." });
  });

  it("a failed login: Terno's own words as they are, anything else wrapped with the address", () => {
    const own = loginFailed("errors.couldNotConnectAccount", "ana@x.mx", new ProviderError(L("errors.imap.badLogin"), false));
    expect(own).toMatchObject({ code: "BAD_REQUEST", message: "Incorrect username or password (IMAP).", i18n: { key: "errors.imap.badLogin" } });
    const foreign = loginFailed("errors.couldNotVerifyAccount", "ana@x.mx", new Error("ECONNRESET"));
    expect(foreign).toMatchObject({ message: "Couldn’t verify ana@x.mx: ECONNRESET", i18n: { key: "errors.couldNotVerifyAccount", params: { email: "ana@x.mx", detail: "ECONNRESET" } } });
    expect(loginFailed("errors.couldNotConnect", "ana@x.mx", "timeout").message).toBe("Couldn’t connect: timeout");
  });

  it("an unreadable secret says which one and where to enter it again", () => {
    const e = new SecretUnreadableError("account:3:refreshToken", false);
    expect(e.message).toBe("The keychain won’t open this account’s Google session. Reconnect it in Settings → Accounts (Connect with Google).");
    expect(e.i18n).toEqual({ key: "errors.secret.keychain.googleSession" });
    expect(new SecretUnreadableError("ai:openai", true).i18n).toEqual({ key: "errors.secret.legacy.apiKey" });
    expect(new SecretUnreadableError("something", false).i18n).toEqual({ key: "errors.secret.keychain.other" });
    setLocale("es", es);
    expect(translate({ ...e.i18n, message: e.message })).toBe("El llavero no abre la sesión de Google de esta cuenta. Vuelve a conectarla en Ajustes → Cuentas (Conectar con Google).");
  });
});

describe("op summaries", () => {
  it("say what an op is, with the count's plural, in both languages", () => {
    expect(opSummary("send", "Hola", 1)).toEqual({ summary: "Send “Hola”", summaryI18n: { key: "backend.op.send", params: { subject: "Hola" } } });
    expect(opSummary("archive", "", 1).summary).toBe("Archive 1 message");
    expect(opSummary("markRead", "", 3).summary).toBe("Mark 3 messages as read");
    expect(opSummary("setLabels", "", 2)).toEqual({ summary: "setLabels · 2 messages", summaryI18n: { key: "backend.op.other", params: { kind: "setLabels", count: 2 } } });
    setLocale("es", es);
    const shown = (kind: string, n: number) => {
      const { summary, summaryI18n } = opSummary(kind, "Hola", n);
      return translate({ ...summaryI18n!, message: summary });
    };
    expect(shown("send", 1)).toBe("Enviar «Hola»");
    expect(shown("trash", 1)).toBe("Mover 1 mensaje a la papelera");
    expect(shown("markUnread", 2)).toBe("Marcar 2 mensajes como no leídos");
  });
});

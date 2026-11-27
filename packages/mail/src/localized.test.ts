import { describe, expect, it } from "vitest";
import { callbackPage } from "./gmail";
import { classifySmtpError } from "./smtp";

describe("what the mail providers say to the user", () => {
  it("the page after Google's redirect carries every language; the browser shows its own, English without script", async () => {
    const page = await callbackPage();
    const ok = page(true, "backend.oauth.back");
    expect(ok).toContain('<div lang="en-US" data-locale="en"><h1>Account connected</h1><p>You can close this tab and go back to Terno.</p></div>');
    expect(ok).toContain('<div lang="es-MX" data-locale="es" hidden><h1>Cuenta conectada</h1><p>Ya puedes cerrar esta pestaña y volver a Terno.</p></div>');
    expect(ok).toContain("<title>Account connected</title>");
    expect(ok).toContain("<main data-ok>");
    expect(ok).toContain("navigator.languages");
    // nothing leaves the machine: no remote fonts, images or scripts
    expect(ok).not.toMatch(/(?:src|href)=|url\(|@import/);
    const denied = page(false, "backend.oauth.denied");
    expect(denied).toContain("<main data-fail>");
    expect(denied).toContain("<h1>Couldn’t connect</h1><p>Google didn’t give Terno access. Go back to Terno to try again.</p>");
    expect(denied).toContain("<h1>No se pudo conectar</h1><p>Google no le dio acceso a Terno. Vuelve a Terno para intentarlo de nuevo.</p>");
    // shown for a forged or stale state and for a malformed answer alike, so it claims neither
    expect(page(false, "backend.oauth.invalid")).toContain("<p>Terno couldn’t verify Google’s answer. Go back to Terno to try again.</p>");
  });

  it("SMTP failures are catalog messages around the server's own words; a refused AUTH says its code only (plan 293)", () => {
    // a server may echo what was sent in its refusal: only the code reaches the user
    const auth = classifySmtpError({ code: "EAUTH", responseCode: 535, message: "535 5.7.8 bad credentials for luis@example.com / hunter2" });
    expect(auth).toMatchObject({ message: "SMTP authentication failed: 535", retryable: false, i18n: { key: "errors.smtp.authFailed", params: { detail: "535" } } });
    expect(JSON.stringify(auth)).not.toContain("hunter2");
    const lost = classifySmtpError({ code: "ECONNECTION", message: "socket hang up" }, true);
    expect(lost).toMatchObject({ ambiguous: true, i18n: { key: "errors.smtp.connectionLost" } });
    // a server's reply passes through as it is
    expect(classifySmtpError({ responseCode: 451, message: "451 try later" }).i18n).toBeUndefined();
  });
});

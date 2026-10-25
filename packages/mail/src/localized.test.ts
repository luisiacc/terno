import { describe, expect, it } from "vitest";
import { callbackPage } from "./gmail";
import { classifySmtpError } from "./smtp";

describe("what the mail providers say to the user", () => {
  it("the page after Google's redirect carries every language; the browser shows its own, English without script", async () => {
    const page = await callbackPage();
    const ok = page(true, "backend.oauth.back");
    expect(ok).toContain('<div lang="en-US" data-locale="en"><h2>Account connected ✓</h2><p>You can go back to Terno now.</p></div>');
    expect(ok).toContain('<div lang="es-MX" data-locale="es" hidden><h2>Cuenta conectada ✓</h2><p>Ya puedes volver a Terno.</p></div>');
    expect(ok).toContain("navigator.languages");
    const denied = page(false, "backend.oauth.denied");
    expect(denied).toContain("<h2>Couldn’t connect</h2><p>Permission denied.</p>");
    expect(denied).toContain("<h2>No se pudo conectar</h2><p>Permiso denegado.</p>");
  });

  it("SMTP failures are catalog messages around the server's own words", () => {
    const auth = classifySmtpError({ code: "EAUTH", message: "535 5.7.8 bad credentials" });
    expect(auth).toMatchObject({ message: "SMTP authentication failed: 535 5.7.8 bad credentials", retryable: false, i18n: { key: "errors.smtp.authFailed", params: { detail: "535 5.7.8 bad credentials" } } });
    const lost = classifySmtpError({ code: "ECONNECTION", message: "socket hang up" }, true);
    expect(lost).toMatchObject({ ambiguous: true, i18n: { key: "errors.smtp.connectionLost" } });
    // a server's reply passes through as it is
    expect(classifySmtpError({ responseCode: 451, message: "451 try later" }).i18n).toBeUndefined();
  });
});

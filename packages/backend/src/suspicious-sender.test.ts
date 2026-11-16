import { describe, expect, it } from "vitest";
import { impersonates, suspiciousSender, untrustedSenders } from "./suspicious-sender";

describe("a sender named like a security desk (plan 204, after the fourth panel round)", () => {
  it("the panel's two phishing mails", () => {
    expect(suspiciousSender("security@tririver-fcu-alerts.com")).toBe(true);
    expect(suspiciousSender("seguridad@bbva-mx-alertas.com.verifica-acceso.info")).toBe(true);
    // and their kind, in English and Spanish
    expect(suspiciousSender("noreply@chase-secure-login.net")).toBe(true);
    expect(suspiciousSender("avisos@santander-cuenta.com.mx")).toBe(true);
    expect(suspiciousSender("help@paypal-account-support.co.uk")).toBe(true);
    expect(suspiciousSender("x@Mail.Wellsfargo-Verify.com.")).toBe(true);
  });
  it("genuine senders: a bank's, a service's, a subdomain named for its job, a country's suffix", () => {
    for (const email of [
      "alerts@paybridge.com",
      "billing@stratus.app",
      "alerts@tririverfcu.org",
      "notifications@github.com",
      "no-reply@accounts.google.com",
      "avisos@bbva.mx",
      "alertas@bbva.com.mx",
      "security@alerts.hsbc.co.uk",
      "support@account.microsoft.com",
      "news@e-flyer.example.com",
      "hello@coca-cola.com",
      "orders@mercado-libre.com.mx",
      "",
      "not an address",
    ]) expect(suspiciousSender(email), email).toBe(false);
  });
});

describe("plan 210 (iteration 4's code review): a sender named like the reader's own organization, or a helpdesk", () => {
  it("the panel's Lumora helpdesk, and a helpdesk's or a credential's words", () => {
    expect(impersonates("it-helpdesk@lumora-io.co", ["priya@lumora.io"])).toBe(true);
    expect(impersonates("soporte@panaderia-mx.com", ["lucia@panaderia.mx"])).toBe(true);
    expect(suspiciousSender("it@acme-helpdesk.com")).toBe(true);
    expect(suspiciousSender("noreply@bancoandino-validacion.com")).toBe(true);
    expect(suspiciousSender("x@mailbox-password.net")).toBe(true);
  });
  it("the organization's own site, a subdomain, a name that only contains it, or a short name, aren't", () => {
    expect(impersonates("it-helpdesk@lumora.io", ["priya@lumora.io"])).toBe(false);
    expect(impersonates("it@help.lumora.io", ["priya@lumora.io"])).toBe(false);
    expect(impersonates("hello@lumorabakery.com", ["priya@lumora.io"])).toBe(false);
    expect(impersonates("news@ibm-events.com", ["me@ibm.com"])).toBe(false);
    expect(impersonates("it-helpdesk@lumora-io.co", [])).toBe(false);
  });
  it("the guard trusts whoever the user has written to", async () => {
    const none = async () => new Set<string>();
    expect([...(await untrustedSenders(["it-helpdesk@lumora-io.co"], none, ["priya@lumora.io"]))]).toEqual(["it-helpdesk@lumora-io.co"]);
    expect((await untrustedSenders(["it-helpdesk@lumora-io.co"], async (keys) => new Set(keys), ["priya@lumora.io"])).size).toBe(0);
    // without the reader's addresses, as the read guards have it, nothing changes
    expect((await untrustedSenders(["it-helpdesk@lumora-io.co"], none)).size).toBe(0);
  });
});

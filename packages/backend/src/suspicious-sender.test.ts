import { describe, expect, it } from "vitest";
import { suspiciousSender } from "./suspicious-sender";

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

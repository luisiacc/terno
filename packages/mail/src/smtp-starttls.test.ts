import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendViaSmtp, verifySmtp, type SmtpConfig } from "./smtp";
import { ProviderAuthError, ProviderError, type SendPayload } from "./types";
import { smtpCertificates, startSmtpFixture, type SmtpScript, type SmtpSession } from "./test/smtp-starttls.fixture";

let certificates: ReturnType<typeof smtpCertificates>;
const fixtures: Awaited<ReturnType<typeof startSmtpFixture>>[] = [];
beforeAll(() => { certificates = smtpCertificates(); });
afterAll(() => certificates?.close());
afterEach(async () => {
  vi.restoreAllMocks();
  const owned = fixtures.splice(0);
  const results = await Promise.allSettled(owned.map((fixture) => fixture.close()));
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  expect(owned.flatMap((fixture) => fixture.errors)).toEqual([]);
});

const payload: SendPayload = {
  from: { name: "", email: "sender@example.test" }, to: [{ name: "", email: "recipient@example.test" }],
  cc: [], bcc: [], subject: "Synthetic STARTTLS", text: "Synthetic body", messageId: "starttls@example.test",
  inReplyTo: null, references: [], providerThreadId: null,
};
const accepted = () => vi.fn();
async function setup(script?: (connection: number) => SmtpScript, options: { trust?: boolean; wrongSan?: boolean } = {}) {
  const fixture = await startSmtpFixture({ ...certificates, cert: options.wrongSan ? certificates.wrongCert : certificates.cert }, script);
  fixtures.push(fixture);
  if (options.trust !== false) {
    const create = nodemailer.createTransport.bind(nodemailer);
    vi.spyOn(nodemailer, "createTransport").mockImplementation((...args: Parameters<typeof nodemailer.createTransport>) => {
      const transportOptions = args[0] as SMTPTransport.Options;
      if (transportOptions.host !== "127.0.0.1" || transportOptions.port !== fixture.port) throw new Error("Test CA must remain scoped to its loopback fixture");
      return create({ ...transportOptions, tls: { ...transportOptions.tls, ca: certificates.ca } });
    });
  }
  const config: SmtpConfig = { host: "127.0.0.1", port: fixture.port, secure: false, user: "synthetic-user", password: "synthetic-password", socketTimeoutMs: 1000 };
  return { ...fixture, config };
}

async function closed(session: SmtpSession) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([session.closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SMTP client did not close its session")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
function trace(session: SmtpSession) {
  return session.events.map(({ tls, command }) => `${tls ? "tls" : "plain"}:${command
    .replace(/^EHLO .+$/, "EHLO").replace(/^AUTH PLAIN .+$/, "AUTH PLAIN")
    .replace(/^c3ludGhldGljLXVzZXI=$/, "[username]").replace(/^c3ludGhldGljLXBhc3N3b3Jk$/, "[password]")}`);
}
function authTrace(mechanism: "PLAIN" | "LOGIN", encrypted = true) {
  const phase = encrypted ? "tls" : "plain";
  return mechanism === "PLAIN" ? [`${phase}:AUTH PLAIN`] : [`${phase}:AUTH LOGIN`, `${phase}:[username]`, `${phase}:[password]`];
}
const envelopeTrace = ["tls:MAIL FROM:<sender@example.test>", "tls:RCPT TO:<recipient@example.test>", "tls:DATA"];
function noSubmission(session: SmtpSession) {
  expect(session.events.filter(({ command }) => /^(AUTH|MAIL|RCPT|DATA)\b/.test(command))).toEqual([]);
  expect(session.credentials).toEqual([]);
  expect(session.bodies).toEqual([]);
}

describe.each(["send", "verify"] as const)("real Nodemailer STARTTLS: %s", (operation) => {
  const invoke = (config: SmtpConfig, callback: () => void) => operation === "send"
    ? sendViaSmtp(config, payload, { accepted: callback }) : verifySmtp(config);

  it.each(["PLAIN", "LOGIN"] as const)("uses only the post-upgrade %s capabilities", async (postAuth) => {
    const fixture = await setup(() => ({ preAuth: postAuth === "PLAIN" ? "LOGIN" : "PLAIN", postAuth }));
    const onAccepted = accepted();
    const result = await invoke(fixture.config, onAccepted);
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session)).toEqual([
      "plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO", ...authTrace(postAuth),
      ...(operation === "send" ? envelopeTrace : ["tls:QUIT"]),
    ]);
    expect(session.credentials).toEqual([{ tls: true, mechanism: postAuth, user: "synthetic-user", password: "synthetic-password" }]);
    expect(session.handshakes).toBe(1); expect(session.tlsErrors).toEqual([]);
    expect(session.bodies).toHaveLength(operation === "send" ? 1 : 0);
    expect(onAccepted).toHaveBeenCalledTimes(operation === "send" ? 1 : 0);
    if (operation === "send") expect(session.bodies[0]!.equals((result as { raw: Buffer }).raw)).toBe(true);
  });

  it("upgrades required TLS even without an advertisement", async () => {
    const fixture = await setup(() => ({ advertise: false }));
    const onAccepted = accepted(); await invoke(fixture.config, onAccepted);
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session).slice(0, 4)).toEqual(["plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO"]);
    expect(session.credentials[0]).toMatchObject({ tls: true, mechanism: "LOGIN" });
    expect(session.bodies).toHaveLength(operation === "send" ? 1 : 0);
  });

  it("reads changed capabilities on fresh attempts at the same endpoint and refuses a later downgrade", async () => {
    const fixture = await setup((connection) => connection === 2 ? { advertise: false, upgrade: "refuse" } : { postAuth: connection === 0 ? "LOGIN" : "PLAIN" });
    const onAccepted = accepted();
    await invoke(fixture.config, onAccepted); await closed(fixture.sessions[0]!);
    await invoke(fixture.config, onAccepted); await closed(fixture.sessions[1]!);
    await expect(invoke(fixture.config, onAccepted)).rejects.toThrow();
    expect(fixture.sessions).toHaveLength(3); await closed(fixture.sessions[2]!);
    expect(fixture.sessions.map((session) => session.credentials.map((entry) => entry.mechanism))).toEqual([["LOGIN"], ["PLAIN"], []]);
    for (const session of fixture.sessions.slice(0, 2)) {
      expect(trace(session).slice(0, 4)).toEqual(["plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO"]);
      expect(session.handshakes).toBe(1); expect(session.tlsErrors).toEqual([]);
    }
    noSubmission(fixture.sessions[2]!);
    expect(fixture.sessions.flatMap((session) => session.bodies)).toHaveLength(operation === "send" ? 2 : 0);
    expect(onAccepted).toHaveBeenCalledTimes(operation === "send" ? 2 : 0);
  });

  it.each(["unadvertised refusal", "advertised refusal", "negotiation failure", "untrusted CA", "wrong SAN"] as const)("never sends credentials or submits after %s", async (fault) => {
    const fixture = await setup(() => ({
      advertise: fault !== "unadvertised refusal",
      upgrade: fault.includes("refusal") ? "refuse" : fault === "negotiation failure" ? "broken" : undefined,
    }), { trust: fault !== "untrusted CA", wrongSan: fault === "wrong SAN" });
    const onAccepted = accepted();
    const error = await invoke(fixture.config, onAccepted).then(() => { throw new Error("Unsafe TLS operation succeeded"); }, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (operation === "send") expect(error).toMatchObject({ ambiguous: false, network: false });
    else expect(error).toMatchObject({ code: fault.includes("refusal") ? "ETLS" : "ESOCKET" });
    if (fault === "wrong SAN") expect((error as Error).message).toMatch(/IP.*cert|altname/i);
    if (fault === "untrusted CA") expect((error as Error).message).toMatch(/certificate|issuer/i);
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session)).toEqual(["plain:EHLO", "plain:STARTTLS"]);
    expect(session.handshakes).toBe(0); noSubmission(session);
    expect(onAccepted).not.toHaveBeenCalled();
    if (fault === "negotiation failure") expect(session.tlsErrors.length).toBeGreaterThan(0);
  });

  it("retains explicit plaintext configuration even when STARTTLS is advertised", async () => {
    const fixture = await setup();
    const onAccepted = accepted(); await invoke({ ...fixture.config, allowInsecure: true }, onAccepted);
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session)).toEqual(["plain:EHLO", ...authTrace("PLAIN", false),
      ...(operation === "send" ? envelopeTrace.map((entry) => entry.replace("tls:", "plain:")) : ["plain:QUIT"])]);
    expect(session.handshakes).toBe(0);
    expect(session.credentials).toEqual([{ tls: false, mechanism: "PLAIN", user: "synthetic-user", password: "synthetic-password" }]);
    expect(session.bodies).toHaveLength(operation === "send" ? 1 : 0);
  });

  it("uses implicit TLS when explicitly configured", async () => {
    const fixture = await setup(() => ({ implicit: true }));
    const onAccepted = accepted(); await invoke({ ...fixture.config, secure: true }, onAccepted);
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session)).toEqual(["tls:[TLS established]", "tls:EHLO", ...authTrace("LOGIN"),
      ...(operation === "send" ? envelopeTrace : ["tls:QUIT"])]);
    expect(session.handshakes).toBe(1); expect(session.tlsErrors).toEqual([]);
    expect(session.bodies).toHaveLength(operation === "send" ? 1 : 0);
  });

  it.each(["auth535", "auth454"] as const)("retains %s refusal after TLS", async (fault) => {
    const fixture = await setup(() => ({ fault }));
    const onAccepted = accepted();
    const error = await invoke(fixture.config, onAccepted).catch((failure: unknown) => failure);
    if (operation === "send") {
      expect(error).toBeInstanceOf(fault === "auth535" ? ProviderAuthError : ProviderError);
      expect(error).toMatchObject({ retryable: fault === "auth454", ambiguous: false });
    } else expect(error).toMatchObject({ code: "EAUTH", responseCode: fault === "auth535" ? 535 : 454 });
    expect(fixture.sessions).toHaveLength(1);
    const session = fixture.sessions[0]!; await closed(session);
    expect(trace(session)).toEqual(["plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO", ...authTrace("LOGIN")]);
    expect(session.bodies).toEqual([]); expect(onAccepted).not.toHaveBeenCalled();
  });
});

it("retains definitive recipient refusal after TLS", async () => {
  const fixture = await setup(() => ({ fault: "rcpt550" }));
  const onAccepted = accepted();
  const error = await sendViaSmtp(fixture.config, payload, { accepted: onAccepted }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({ retryable: false, ambiguous: false });
  expect(fixture.sessions).toHaveLength(1);
  const session = fixture.sessions[0]!; await closed(session);
  expect(trace(session)).toEqual(["plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO", ...authTrace("LOGIN"), ...envelopeTrace.slice(0, 2)]);
  expect(session.bodies).toEqual([]); expect(onAccepted).not.toHaveBeenCalled();
});

it("allows a caller retry after a pre-354 drop with fresh capabilities and no first body", async () => {
  const fixture = await setup((connection) => connection === 0 ? { fault: "before354", postAuth: "LOGIN" } : { postAuth: "PLAIN" });
  const onAccepted = accepted();
  await expect(sendViaSmtp(fixture.config, payload, { accepted: onAccepted })).rejects.toMatchObject({ retryable: true, ambiguous: false });
  expect(fixture.sessions).toHaveLength(1); await closed(fixture.sessions[0]!);
  expect(fixture.sessions[0]!.bodies).toEqual([]); expect(onAccepted).not.toHaveBeenCalled();
  await sendViaSmtp(fixture.config, payload, { accepted: onAccepted });
  expect(fixture.sessions).toHaveLength(2); await closed(fixture.sessions[1]!);
  expect(fixture.sessions.map((session) => session.credentials[0]!.mechanism)).toEqual(["LOGIN", "PLAIN"]);
  expect(fixture.sessions.flatMap((session) => session.bodies)).toHaveLength(1);
  expect(onAccepted).toHaveBeenCalledOnce();
});

it("retains ambiguity after complete TLS DATA with a lost final reply, without an internal reconnect", async () => {
  const fixture = await setup(() => ({ fault: "afterBody" }));
  const onAccepted = accepted();
  await expect(sendViaSmtp(fixture.config, payload, { accepted: onAccepted })).rejects.toMatchObject({ retryable: false, ambiguous: true });
  expect(fixture.sessions).toHaveLength(1);
  const session = fixture.sessions[0]!; await closed(session);
  expect(trace(session)).toEqual(["plain:EHLO", "plain:STARTTLS", "tls:[TLS established]", "tls:EHLO", ...authTrace("LOGIN"), ...envelopeTrace]);
  expect(session.bodies).toHaveLength(1); expect(session.bodies[0]!.toString()).toContain("Synthetic body\r\n");
  expect(onAccepted).not.toHaveBeenCalled();
});

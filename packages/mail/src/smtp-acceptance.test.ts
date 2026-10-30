import { createRequire } from "node:module";
import nodemailer from "nodemailer";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale, L, translate } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { sendViaSmtp, smtpRecipientOutcomes } from "./smtp";
import { sentCopyWarning } from "./sent-copy";

const { SMTPServer } = createRequire(new URL("../../backend/src/imap.int.test.ts", import.meta.url))("smtp-server") as typeof import("../../backend/node_modules/@types/smtp-server");
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); setLocale("en", en); for (const close of closes.splice(0)) await close(); });

it("latches real SMTP acceptance before normalization and preserves recipient uncertainty with saved or failed copies", async () => {
  const received: Buffer[] = [];
  const server = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onAuth: (_auth, _session, cb) => cb(null, { user: "synthetic" }), onData(stream, _session, cb) {
    const chunks: Buffer[] = []; stream.on("data", (chunk: Buffer) => chunks.push(chunk)); stream.on("end", () => { received.push(Buffer.concat(chunks)); cb(); });
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closes.push(() => new Promise<void>((resolve) => server.close(resolve)));
  const port = (server.server.address() as { port: number }).port;
  const create = nodemailer.createTransport.bind(nodemailer);
  const factory = vi.spyOn(nodemailer, "createTransport").mockImplementation((...args: Parameters<typeof nodemailer.createTransport>) => {
    const transport = create(...args);
    const send = transport.sendMail.bind(transport);
    transport.sendMail = (async (input: Parameters<typeof send>[0]) => {
      const info = await send(input);
      return Object.defineProperty(info, "rejected", { get() { throw new Error("Synthetic normalization failure after acceptance"); } });
    }) as typeof transport.sendMail;
    return transport;
  });
  const accepted = vi.fn();
  const result = await sendViaSmtp({ host: "127.0.0.1", port, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, { from: { name: "", email: "sender@example.test" }, to: [{ name: "", email: "recipient@example.test" }], cc: [], bcc: [], subject: "Synthetic", text: "Once", messageId: "once@example.test", inReplyTo: null, references: [], providerThreadId: null }, { accepted });
  expect(factory).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce(); expect(received).toHaveLength(1);
  expect(result).toMatchObject({ recipientOutcomeUnknown: true, rejected: [] });
  for (const copy of ["saved", "rejected", "unknown"] as const) {
    const warning = sentCopyWarning(copy, L("errors.smtp.recipientOutcomeUnknown"))!;
    expect(warning.key).toBe(copy === "saved" ? "errors.smtp.recipientOutcomeUnknown" : copy === "rejected" ? "errors.sentCopy.recipientUnknownMissing" : "errors.sentCopy.recipientUnknownCopy");
    for (const [locale, catalog] of [["en", en], ["es", es]] as const) {
      setLocale(locale, catalog); const text = translate(warning);
      expect(text).toContain(locale === "en" ? "recipient details" : "detalles de los destinatarios");
      expect(text).not.toContain(locale === "en" ? "Not delivered to" : "No se entregó a");
    }
  }
});

it("reports each SMTP submission outcome for a partial envelope", async () => {
  const recipients: string[] = [];
  let data = 0;
  const server = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onAuth: (_auth, _session, cb) => cb(null, { user: "synthetic" }), onRcptTo(address, _session, cb) {
    recipients.push(address.address);
    cb(address.address === "refused@example.test" ? Object.assign(new Error("refused"), { responseCode: 550 }) : undefined);
  }, onData(stream, _session, cb) { stream.resume(); stream.on("end", () => { data++; cb(); }); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closes.push(() => new Promise<void>((resolve) => server.close(resolve)));
  const port = (server.server.address() as { port: number }).port;
  const result = await sendViaSmtp({ host: "127.0.0.1", port, secure: false, user: "synthetic", password: "synthetic", allowInsecure: true }, { from: { name: "", email: "sender@example.test" }, to: [{ name: "", email: "first@example.test" }, { name: "", email: "refused@example.test" }], cc: [], bcc: [{ name: "", email: "hidden@example.test" }], subject: "Synthetic", text: "Once", messageId: "partial@example.test", inReplyTo: null, references: [], providerThreadId: null });
  expect(recipients).toEqual(["first@example.test", "refused@example.test", "hidden@example.test"]);
  expect(data).toBe(1);
  expect(result).toMatchObject({ outcomes: [
    { email: "first@example.test", outcome: "accepted" },
    { email: "refused@example.test", outcome: "rejected" },
    { email: "hidden@example.test", outcome: "accepted" },
  ] });
});


it("fails closed on incomplete, overlapping, foreign and case-colliding reports", () => {
  const envelope = ["a@example.test", "b@example.test"];
  const unknown = envelope.map((email) => ({ email, outcome: "unknown" }));
  for (const [accepted, rejected] of [
    [["a@example.test"], []],
    [["a@example.test"], ["a@example.test", "b@example.test"]],
    [["a@example.test"], ["b@example.test", "foreign@example.test"]],
    [["a@example.test"], null],
    [["A@example.test"], ["b@example.test"]],
    [["a@example.test"], [{ address: 4 }]],
  ]) expect(smtpRecipientOutcomes(envelope, accepted, rejected)).toEqual(unknown);
  expect(smtpRecipientOutcomes(["a@example.test", "A@example.test"], ["a@example.test"], ["A@example.test"]).every((entry) => entry.outcome === "unknown")).toBe(true);
  expect(smtpRecipientOutcomes(["a@example.test", "a@example.test", "b@example.test"], ["a@example.test"], ["b@example.test"])).toEqual([
    { email: "a@example.test", outcome: "accepted" }, { email: "a@example.test", outcome: "accepted" }, { email: "b@example.test", outcome: "rejected" },
  ]);
});

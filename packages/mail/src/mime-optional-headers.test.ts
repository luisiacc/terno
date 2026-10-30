import { describe, expect, it } from "vitest";
import { processIncoming } from "./incoming-processing-worker";
import { headerFields, messageAddresses, parseRaw, type ParsedMessage } from "./mime";

const bytes = (text: string) => new TextEncoder().encode(text);
const addresses = [
  "From: =?UTF-8?Q?Boss_<boss@corp.test>?= <Actual@sender.test>",
  'Reply-To: "Support <audit@thirdparty.test>, Helpdesk" <Session@help.test>',
  "To: Reader <reader@test.com>",
];
const faults = [
  "List-Unsubscribe: <https://[broken>",
  "Content-Location: https://[broken",
  "Date: definitely-not-a-date",
  "List-Id: <>",
  "Subject: =?x-unknown?Q?caf=E9?=",
];

function wire(headers: string[]): string {
  return [
    ...addresses, ...headers, "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="witness"', "",
    "--witness", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "",
    "Readable café body.", "Keep this line.",
    "--witness", "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="witness.bin"',
    "Content-Transfer-Encoding: base64", "", "AP+AQQ0K", "--witness--", "",
  ].join("\r\n");
}

type Metadata = Pick<ParsedMessage, "subject" | "date" | "listId" | "bulk">;
const defaults: Metadata = { subject: "", date: null, listId: null, bulk: false };

function expectReadable(message: ParsedMessage, metadata: Partial<Metadata>) {
  expect(message).toMatchObject({
    ...defaults, ...metadata,
    from: { name: "Boss", email: "actual@sender.test" },
    replyTo: [{ name: "Support, Helpdesk", email: "session@help.test" }],
    to: [{ name: "Reader", email: "reader@test.com" }],
    text: "Readable café body.\nKeep this line.", html: null,
  });
  expect(message.captureUnavailable).toBeUndefined();
  expect(message.attachments).toHaveLength(1);
  expect(message.attachments[0]).toMatchObject({ filename: "witness.bin", mime: "application/octet-stream", size: 6, contentId: null });
  expect(message.attachments[0]!.bytes).toEqual(new Uint8Array([0, 255, 128, 65, 13, 10]));
}

const cases: { name: string; headers: string[]; metadata: Partial<Metadata> }[] = [
  { name: "absent optional fields", headers: [], metadata: {} },
  { name: "relative unsubscribe target", headers: ["List-Unsubscribe: <here>"], metadata: { bulk: true } },
  { name: "unsubscribe prose", headers: ["List-Unsubscribe: ask the sender to stop"], metadata: { bulk: true } },
  { name: "invalid unsubscribe host", headers: ["List-Unsubscribe: <https://[broken>"], metadata: { bulk: true } },
  { name: "incomplete mailto", headers: ["List-Unsubscribe: <mailto:>"], metadata: { bulk: true } },
  { name: "folded mixed unsubscribe targets", headers: ["List-Unsubscribe: <here>,\r\n\t<https://lists.test/stop>"], metadata: { bulk: true } },
  { name: "blank unsubscribe", headers: ["List-Unsubscribe: \t "], metadata: {} },
  { name: "ignored invalid optional URLs", headers: ["Content-Location: https://[broken", "List-Help: <here>", "List-Archive: not a URL"], metadata: {} },
  { name: "invalid Date", headers: ["Date: definitely-not-a-date"], metadata: {} },
  { name: "out-of-range Date", headers: ["Date: +999999-01-01T00:00:00Z"], metadata: {} },
  { name: "timezone-qualified epoch control", headers: ["Date: Thu, 01 Jan 1970 01:00:00 +0100"], metadata: { date: 0 } },
  { name: "empty List-ID brackets stay opaque", headers: ["List-Id: <>"], metadata: { listId: "<>" } },
  { name: "unclosed List-ID stays opaque", headers: ["List-Id: <BROKEN"], metadata: { listId: "<broken" } },
  { name: "whitespace List-ID payload", headers: ["List-Id: <   >"], metadata: {} },
  { name: "unknown Subject charset with UTF-8 bytes", headers: ["Subject: =?x-unknown?Q?caf=C3=A9?="], metadata: { subject: "café" } },
  { name: "unknown Subject charset with legacy bytes", headers: ["Subject: =?x-unknown?Q?caf=E9?="], metadata: { subject: "café" } },
  { name: "damaged Subject Q escape", headers: ["Subject: =?utf-8?Q?receipt=ZZ?="], metadata: { subject: "receipt=ZZ" } },
  { name: "damaged Subject base64", headers: ["Subject: =?utf-8?B?Y2Fm!!w6k=?="], metadata: { subject: "café" } },
  { name: "unterminated Subject encoded word", headers: ["Subject: =?utf-8?Q?receipt"], metadata: { subject: "=?utf-8?Q?receipt" } },
  { name: "invalid bytes under explicit Subject UTF-8", headers: ["Subject: =?utf-8?Q?caf=E9?="], metadata: { subject: "caf\uFFFD" } },
  { name: "invalid then valid Date", headers: ["Date: broken", "Date: Thu, 01 Jan 1970 00:00:00 +0000"], metadata: {} },
  { name: "valid then invalid Date", headers: ["Date: Thu, 01 Jan 1970 00:00:00 +0000", "Date: broken"], metadata: { date: 0 } },
  { name: "empty then valid Date", headers: ["Date:", "Date: Thu, 01 Jan 1970 00:00:00 +0000"], metadata: {} },
  { name: "malformed then valid List-ID", headers: ["List-Id: <>", "List-Id: News <NEWS.test>"], metadata: { listId: "<>" } },
  { name: "valid then malformed List-ID", headers: ["List-Id: News <NEWS.test>", "List-Id: <>"], metadata: { listId: "news.test" } },
  { name: "empty then valid List-ID", headers: ["List-Id:", "List-Id: News <NEWS.test>"], metadata: {} },
  { name: "empty then nonempty unsubscribe", headers: ["List-Unsubscribe:", "List-Unsubscribe: <here>"], metadata: {} },
  { name: "nonempty then empty unsubscribe", headers: ["List-Unsubscribe: <here>", "List-Unsubscribe:"], metadata: { bulk: true } },
  { name: "broken then valid Subject", headers: ["Subject: =?utf-8?Q?receipt", "Subject: Later"], metadata: { subject: "=?utf-8?Q?receipt" } },
  { name: "valid then broken Subject", headers: ["Subject: First", "Subject: =?utf-8?Q?receipt"], metadata: { subject: "First" } },
  { name: "empty then valid Subject", headers: ["Subject:", "Subject: Later"], metadata: {} },
  { name: "combined faults", headers: faults, metadata: { subject: "café", listId: "<>", bulk: true } },
];

describe.each(["string", "bytes", "processor MIME", "processor Gmail"] as const)("optional headers: %s", (route) => {
  it.each(cases)("$name preserves readable content and raw destinations", async ({ headers, metadata }) => {
    const source = wire(headers);
    let message: ParsedMessage;
    switch (route) {
      case "string": message = await parseRaw(source); break;
      case "bytes": message = await parseRaw(bytes(source)); break;
      case "processor MIME": message = (await processIncoming({ kind: "mime", chunks: [bytes(source)] })).message; break;
      case "processor Gmail": {
        const resource = { id: "message", threadId: "thread", internalDate: "0", raw: Buffer.from(source).toString("base64url") };
        const result = await processIncoming({ kind: "gmail", expectedId: "message", chunks: [bytes(JSON.stringify(resource))] });
        expect(result).toMatchObject({ kind: "gmail", metadata: { id: "message", threadId: "thread", internalDate: "0" } });
        message = result.message;
        break;
      }
    }
    expectReadable(message, metadata);
  });
});

it("selected raw IMAP address fields survive optional faults beside a conflicting envelope", () => {
  const fields = headerFields(bytes([...addresses, ...faults, "List-Unsubscribe: <here>", "", ""].join("\r\n")));
  expect(fields("list-unsubscribe")).toEqual(["<https://[broken>", "<here>"]);
  expect(messageAddresses(fields, {
    from: { name: "Wrong", address: "boss@corp.test" },
    replyTo: [{ name: "Wrong", address: "audit@thirdparty.test" }],
  })).toEqual({
    from: { name: "Boss", email: "actual@sender.test" },
    replyTo: [{ name: "Support, Helpdesk", email: "session@help.test" }],
    to: [{ name: "Reader", email: "reader@test.com" }], cc: [], bcc: [],
  });
});

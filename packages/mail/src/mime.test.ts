import { describe, expect, it } from "vitest";
import { parseRaw, parseRawHeaders } from "./mime";

const raw = (headers: string) => `From: Xataka <boletin@xataka.com>\r\nTo: me@mine.com\r\nSubject: Hola\r\nMessage-ID: <a@x>\r\n${headers}\r\n\r\nCuerpo\r\n`;

describe("parseRaw: bulk headers (plan 17)", () => {
  it("List-Unsubscribe, Precedence bulk/list/junk and Auto-Submitted mark bulk mail; a person's mail has none", async () => {
    expect((await parseRaw(raw(""))).bulk).toBe(false);
    expect((await parseRaw(raw("List-Unsubscribe: <https://xataka.com/u>"))).bulk).toBe(true);
    expect((await parseRaw(raw("Precedence: bulk"))).bulk).toBe(true);
    expect((await parseRaw(raw("Precedence: list"))).bulk).toBe(true);
    expect((await parseRaw(raw("Auto-Submitted: auto-generated"))).bulk).toBe(true);
    expect((await parseRaw(raw("Auto-Submitted: no"))).bulk).toBe(false);
    expect((await parseRaw(raw("List-Id: Boletin <boletin.xataka.com>"))).listId).toBe("boletin.xataka.com");
  });
});


describe("parseRaw: Reply-To", () => {
  it("retains every reply destination and a quoted comma name separately from From", async () => {
    const message = await parseRaw(raw('Reply-To: "Support, Session" <Session@help.test>, List <list@help.test>'));
    expect(message.from).toEqual({ name: "Xataka", email: "boletin@xataka.com" });
    expect(message).toMatchObject({ replyTo: [{ name: "Support, Session", email: "session@help.test" }, { name: "List", email: "list@help.test" }] });
    expect(await parseRaw(raw(""))).toMatchObject({ replyTo: [] });
  });
});


describe("attachment bytes", () => {
  it("retains binary, empty, duplicate filenames and inline CID parts", async () => {
    const source = ["From: me@test.com", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="parts"', "", "--parts", "Content-Type: text/plain", "", "body", ...["AP+A", "", "AQID"].flatMap((data, i) => ["--parts", "Content-Type: image/png", `Content-Disposition: ${i === 2 ? "inline" : "attachment"}; filename="same.png"`, ...(i === 2 ? ["Content-ID: <Photo@Test>"] : []), "Content-Transfer-Encoding: base64", "", data]), "--parts--", ""].join("\r\n");
    const parsed = await parseRaw(source);
    expect(parsed.attachments).toHaveLength(3);
    expect(parsed.attachments.map((a) => [...a.bytes!])).toEqual([[0,255,128], [], [1,2,3]]);
    expect(parsed.attachments[2]).toMatchObject({ contentId: "Photo@Test" });
  });
});

describe("incoming capture budgets", () => {
  it("parses valid incoming raw sources between 35 and 70 MiB independently of the outgoing ceiling", async () => {
    for (const mib of [36, 70]) {
      const header = 'From: Sender <sender@test.com>\r\nSubject: Large incoming\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="large.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n';
      const lines = Math.floor((mib * 1024 * 1024 - header.length) / 78);
      const source = new TextEncoder().encode(header + ("paWl".repeat(19) + "\r\n").repeat(lines));
      const parsed = await parseRaw(source);
      expect(parsed.subject).toBe("Large incoming");
      expect(parsed.attachments[0]!.bytes!.length).toBe(lines * 57);
      expect(parsed.attachments[0]!.bytes![0]).toBe(165);
      expect(parsed.attachments[0]!.bytes!.at(-1)).toBe(165);
    }
  }, 60000);

  it("an over-budget source returns bounded headers and an explicit unavailable capture, never truncated content", async () => {
    const source = new Uint8Array(75 * 1024 * 1024 + 1);
    source.set(new TextEncoder().encode('From: Sender <sender@test.com>\r\nSubject: Oversize envelope\r\nContent-Type: multipart/mixed; boundary="not-parsed"\r\n\r\n'));
    const parsed = await parseRaw(source);
    expect(await parseRawHeaders(source.subarray(0, 65536), "size")).toEqual(parsed);
    expect(parsed).toMatchObject({ subject: "Oversize envelope", from: { email: "sender@test.com" }, text: null, html: null, attachments: [], captureUnavailable: "size" });
  });
});

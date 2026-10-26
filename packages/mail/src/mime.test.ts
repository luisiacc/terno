import { describe, expect, it } from "vitest";
import { parseRaw } from "./mime";

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

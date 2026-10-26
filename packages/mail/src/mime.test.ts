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

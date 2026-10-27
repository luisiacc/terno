import { expect, it } from "vitest";
import { parseRaw } from "./mime";

it("passes public structural limits through the existing MIME mapper", async () => {
  const source = 'Content-Type: multipart/mixed; boundary="p"\r\n\r\n--p\r\nContent-Type: text/plain\r\n\r\none\r\n--p\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--p--\r\n';
  await expect(parseRaw(source, { limits: { maxPartCount: 2 } })).rejects.toMatchObject({ code: "EMAXPARTCOUNT" });
  expect((await parseRaw(source)).text).toContain("one");
});

it("passes the charged aggregate header limit without changing ordinary callers", async () => {
  const source = 'From: sender@test.com\r\nSubject: retained\r\n\r\nbody';
  await expect(parseRaw(source, { limits: { maxHeadersSize: 64 } })).rejects.toMatchObject({ code: "EMAXHEADERSIZE" });
  expect(await parseRaw(source)).toMatchObject({ subject: "retained", text: expect.stringContaining("body") });
});

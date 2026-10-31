import { expect, it } from "vitest";
import { createNodeIncomingProcessor } from "./incoming-worker";
import { parseRaw } from "../../mail/src/mime";

function nested(depth: number) {
  let body = "Content-Type: text/plain\r\n\r\nExact nested body\r\n";
  for (let i = 0; i < depth; i++) body = `Content-Type: multipart/mixed; boundary="d${i}"\r\n\r\n--d${i}\r\n${body}\r\n--d${i}--\r\n`;
  return `Subject: Synthetic\r\n${body}`;
}
it("preserves the installed direct IMAP profile rather than lowering it to Gmail's profile", async () => {
  const worker = createNodeIncomingProcessor();
  try {
    const source = nested(65);
    expect((await parseRaw(source)).text).toBe("Exact nested body\n");
    const input = { kind: "mime" as const, profile: "imap" as const, chunks: [new TextEncoder().encode(source)] };
    expect((await worker.run(input, new AbortController().signal)).message.text).toBe("Exact nested body\n");
    await expect(worker.run({ kind: "mime", chunks: [new TextEncoder().encode(source)] }, new AbortController().signal)).rejects.toMatchObject({ code: "mime-limit-depth" });
    const parts = Array.from({ length: 1001 }, () => "--p\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=part.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP+A\r\n").join("");
    const multipart = `Content-Type: multipart/mixed; boundary=p\r\n\r\n${parts}--p--\r\n`;
    const many = { kind: "mime" as const, profile: "imap" as const, chunks: [new TextEncoder().encode(multipart)] };
    const parsed = await worker.run(many, new AbortController().signal);
    expect(parsed.message.attachments).toHaveLength(1001);
    expect(parsed.message.attachments.every((part) => part.bytes?.length === 3 && part.bytes[0] === 0 && part.bytes[1] === 255 && part.bytes[2] === 128)).toBe(true);
    const deep = { kind: "mime" as const, profile: "imap" as const, chunks: [new TextEncoder().encode(nested(257))] };
    await expect(worker.run(deep, new AbortController().signal)).rejects.toMatchObject({ code: "mime-limit-depth" });
  } finally { await worker.close(); }
});

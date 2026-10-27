import { createBrowserIncomingProcessor } from "../../src/web/worker/incoming-runtime";
import { describe, expect, it } from "./shim";

const source = 'From: Sender <sender@test.com>\r\nSubject: nested browser\r\nContent-Type: text/html\r\n\r\n<b>Exact café</b>';
const input = () => ({ kind: "mime" as const, chunks: [new TextEncoder().encode(source)] });

export function defineIncomingWorkerConformance(): void {
  describe("actual nested incoming worker", () => {
    it("parses ordinary MIME and Gmail wire with exact ownership and metadata", async () => {
      const processor = createBrowserIncomingProcessor();
      try {
        const supplied = input();
        const ordinary = await processor.run(supplied, new AbortController().signal);
        expect(supplied.chunks[0]!.byteLength).toBe(0);
        expect(ordinary.message).toMatchObject({ subject: "nested browser", text: expect.stringContaining("Exact café"), from: { email: "sender@test.com" } });
        const binary = String.fromCharCode(...new TextEncoder().encode(source));
        const wire = new TextEncoder().encode(JSON.stringify({ id: "expected", threadId: "thread", internalDate: "0001700000000000", raw: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_") }));
        const gmail = await processor.run({ kind: "gmail", expectedId: "expected", chunks: [wire.slice(0, 17), wire.slice(17)] }, new AbortController().signal);
        expect(gmail).toMatchObject({ kind: "gmail", metadata: { id: "expected", threadId: "thread", internalDate: "0001700000000000" }, message: ordinary.message });
        const attachments = ['Content-Type: multipart/mixed; boundary="p"', '', ...['AP+A', '', 'AQID'].flatMap((bytes, i) => ['--p', 'Content-Type: image/png', `Content-Disposition: attachment; filename="${i}.png"`, ...(i === 2 ? ['Content-ID: <CID@Test>'] : []), 'Content-Transfer-Encoding: base64', '', bytes]), '--p--', ''].join('\r\n');
        const parsed = await processor.run({ kind: "mime", chunks: [new TextEncoder().encode(attachments)] }, new AbortController().signal);
        expect(parsed.message.attachments.map((part) => [...part.bytes!])).toEqual([[0, 255, 128], [], [1, 2, 3]]);
        expect(parsed.message.attachments[2]!.contentId).toBe("CID@Test");
      } finally { await processor.close(); }
    });

    it("keeps a sibling job alive when an unrelated request is already canceled", async () => {
      const processor = createBrowserIncomingProcessor();
      try {
        const pending = processor.run(input(), new AbortController().signal);
        const aborted = new AbortController();
        aborted.abort(new Error("private-token-marker"));
        await expect(processor.run(input(), aborted.signal)).rejects.toMatchObject({ name: "AbortError", message: "Incoming processing canceled" });
        expect((await pending).message.subject).toBe("nested browser");
        const cancel = new AbortController();
        const parsing = processor.run(input(), cancel.signal);
        const rejected = expect(parsing).rejects.toMatchObject({ name: "AbortError" });
        cancel.abort();
        await rejected;
        await processor.whenIdle();
        expect((await processor.run(input(), new AbortController().signal)).message.subject).toBe("nested browser");
      } finally { await processor.close(); }
    });

    it("returns fixed malformed/resource errors then reuses the emitted worker", async () => {
      const processor = createBrowserIncomingProcessor();
      try {
        await expect(processor.run({ kind: "gmail", expectedId: "expected", chunks: [new TextEncoder().encode('{"private-token-marker":')] }, new AbortController().signal)).rejects.toMatchObject({ code: "malformed-json", message: "Incoming processing failed (malformed-json)" });
        await expect(processor.run({ kind: "mime", chunks: [new TextEncoder().encode('X: x\r\n'.repeat(8193) + '\r\nbody')] }, new AbortController().signal)).rejects.toMatchObject({ code: "mime-limit-headers" });
        expect((await processor.run(input(), new AbortController().signal)).message.subject).toBe("nested browser");
      } finally { await processor.close(); }
    });

    it("applies an explicit result budget inside the nested worker before delivery", async () => {
      const processor = createBrowserIncomingProcessor({ maxResultTextCodeUnits: 2 });
      try {
        await expect(processor.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "result-limit" });
      } finally { await processor.close(); }
    });
  });
}

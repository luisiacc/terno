// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK } from "@terno/core";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
const { resolveCidHtml } = await import("./cid");

afterEach(() => { vi.unstubAllGlobals(); call.mockReset(); });

for (const { mime, sizes } of [
  { mime: "image/png", sizes: [4 * 1024 * 1024] },
  { mime: "image/png", sizes: [4 * 1024 * 1024, 4 * 1024 * 1024] },
  { mime: "image/png", sizes: [4 * 1024 * 1024, 2 * 1024 * 1024 - 64] },
  { mime: "image/jpeg", sizes: [4 * 1024 * 1024] },
]) {
  it(`complete successful CID resolver bounds every CPU slice, including final HTML (${mime}, ${sizes.join("+")} bytes)`, async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const refs = sizes.map((size, i) => ({ id: i + 1, assetId: `asset-${i}`, filename: "image", mime, size, contentId: `photo-${i}` }));
    const bytes = sizes.map((size) => {
      const b = Buffer.alloc(size, 0xa7);
      if (mime === "image/jpeg") {
        b.set([255,216]);
        for (let offset = 2; offset < b.length - 10; offset += 4) b.set([255,224,0,2], offset);
        b.set([255,192,0,8,8,0,1,0,1,0], b.length - 10);
      } else { b.set([137,80,78,71,13,10,26,10]); b.writeUInt32BE(1024, 16); b.writeUInt32BE(1024, 20); }
      return b;
    });
    const chunks = bytes.map((b) => Array.from({ length: Math.ceil(b.length / ATTACHMENT_CHUNK) }, (_, i) => b.subarray(i * ATTACHMENT_CHUNK, (i + 1) * ATTACHMENT_CHUNK).toString("base64")));
    call.mockImplementation(async (method: string, p: { assetId: string; index: number }) => {
      const i = refs.findIndex((r) => r.assetId === p.assetId);
      // The actual RPC suspends between chunks. Keep the real decoding/Blob path in the measurement.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return method === "attachments.info" ? refs[i] : { dataBase64: chunks[i]![p.index] };
    });
    const html = refs.map((r) => `<img src="cid:${r.contentId}" alt="${r.contentId}">`).join("") + '<img src="https://pixel.invalid/track">';
    global.gc?.();
    let previous = process.threadCpuUsage(); let maxCpu = 0; let turns = 0; let active = true;
    const record = () => { const cpu = process.threadCpuUsage(previous); maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000); previous = process.threadCpuUsage(); };
    const heartbeat = () => { record(); turns++; if (active) timer = setImmediate(heartbeat); };
    let timer = setImmediate(heartbeat);
    let output: string;
    try { output = await resolveCidHtml(html, 7, refs, () => true); record(); }
    finally { active = false; clearImmediate(timer); }
    process.stderr.write(`[complete CID ${mime} ${sizes.join("+")}] ${turns} turns; maxCPU ${maxCpu.toFixed(2)} ms; output ${output.length}\n`);
    expect(maxCpu).toBeLessThanOrEqual(15);
    expect(turns).toBeGreaterThan(100);
    expect(output).toContain(`data:${mime};base64,`);
    expect(output.length).toBeLessThanOrEqual(8 * 1024 * 1024 + html.length);
    const dom = document.createElement("template"); dom.innerHTML = output;
    for (const [i, img] of [...dom.content.querySelectorAll("img")].entries()) {
      const src = img.getAttribute("src");
      if (src?.startsWith("data:")) expect(Buffer.from(src.slice(src.indexOf(",") + 1), "base64").equals(bytes[i]!)).toBe(true);
    }
    expect(output).toContain('src="https://pixel.invalid/track"');
  });
}

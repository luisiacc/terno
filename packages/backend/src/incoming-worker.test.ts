import { markAsUntransferable } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createNodeIncomingProcessor } from "./incoming-worker";
import type { IncomingProcessor } from "@terno/mail/portable";

const processors: IncomingProcessor[] = [];
const directories: string[] = [];
const input = () => ({ kind: "mime" as const, chunks: [new TextEncoder().encode('From: Sender <sender@test.com>\r\nSubject: actual worker\r\n\r\nbody')] });
function processor(url?: URL) {
  const created = createNodeIncomingProcessor(url);
  processors.push(created);
  return created;
}
function fixture(source: string): URL {
  const dir = mkdtempSync(join(tmpdir(), "terno-incoming-worker-"));
  directories.push(dir);
  const file = join(dir, "fixture.cjs");
  writeFileSync(file, source);
  return pathToFileURL(file);
}
afterEach(async () => {
  for (const owned of processors.splice(0)) await owned.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("uses the real emitted worker through the public lazy factory and transfers input ownership", async () => {
  const owned = processor();
  const source = input();
  const parsed = await owned.run(source, new AbortController().signal);
  expect(source.chunks[0]!.byteLength).toBe(0);
  expect(parsed).toMatchObject({ kind: "mime", message: { subject: "actual worker", from: { email: "sender@test.com" }, text: expect.stringContaining("body") } });
  expect(await owned.run(input(), new AbortController().signal)).toEqual(parsed);
  const html = await owned.run({ kind: "mime", chunks: [new TextEncoder().encode("Content-Type: text/html\r\n\r\n<b>worker HTML</b>")] }, new AbortController().signal);
  expect(html.message.text).toContain("worker HTML");
});

it("reports a missing emitted entry without hanging or exposing filesystem details", async () => {
  const owned = processor(new URL("file:///nonexistent-terno-incoming-worker/entry.cjs"));
  await expect(owned.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-fault", message: "Incoming processing failed (worker-fault)" });
});

it.each(["process.exit(0)", "throw new Error('private-token-marker https://private.test')"])("settles worker exit/startup failure: %s", async (source) => {
  await expect(processor(fixture(source)).run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-fault", message: "Incoming processing failed (worker-fault)" });
});

it("normalizes actual Node marked-untransferable buffers without copying or inline fallback", async () => {
  const source = input();
  markAsUntransferable(source.chunks[0]!.buffer);
  await expect(processor().run(source, new AbortController().signal)).rejects.toMatchObject({ code: "worker-fault" });
  expect(source.chunks[0]!.byteLength).toBeGreaterThan(0);
});

it("cancels an active noncooperative worker and explicitly recreates only after retirement", async () => {
  const owned = processor(fixture("require('node:worker_threads').parentPort.on('message', () => { for (;;) {} });"));
  const abort = new AbortController();
  const pending = owned.run(input(), abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort(new Error("private-token-marker"));
  await rejected;
  await owned.close();
  await expect(owned.run(input(), new AbortController().signal)).rejects.toMatchObject({ code: "worker-closed" });
});

it("returns allowlisted parser resource failures and keeps the actual worker usable", async () => {
  const owned = processor();
  const oversizedHeaders = { kind: "mime" as const, chunks: [new TextEncoder().encode('X: x\r\n'.repeat(8193) + '\r\nbody')] };
  await expect(owned.run(oversizedHeaders, new AbortController().signal)).rejects.toMatchObject({ code: "mime-limit-headers" });
  expect((await owned.run(input(), new AbortController().signal)).message.subject).toBe("actual worker");
});

it("runs a copied host/worker outside the workspace, strips inherited loader flags and exits idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-copied-incoming-"));
  directories.push(dir);
  copyFileSync(fileURLToPath(new URL("../dist/incoming.worker.cjs", import.meta.url)), join(dir, "incoming.worker.cjs"));
  const preload = join(dir, "loader.cjs");
  writeFileSync(preload, "if (!require('node:worker_threads').isMainThread) throw new Error('private-loader-marker');");
  const entry = fileURLToPath(new URL("./incoming-worker.ts", import.meta.url));
  const output = join(dir, "backend.cjs");
  const bundled = await build({
    stdin: {
      contents: `import { createNodeIncomingProcessor } from ${JSON.stringify(entry)};
        void (async () => {
          const processor = createNodeIncomingProcessor();
          const result = await processor.run({kind:'mime', chunks:[new TextEncoder().encode('Subject: copied\\r\\n\\r\\nbody')]}, new AbortController().signal);
          console.log(JSON.stringify({subject:result.message.subject}));
        })();`,
      resolveDir: dir,
      loader: "ts",
    },
    outfile: output, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["node:*"], metafile: true,
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__importMetaUrl" },
    logLevel: "silent",
  });
  expect(Object.keys(bundled.metafile.inputs).some((file) => /postal-mime|incoming-processing-worker|\/mime\.ts$/.test(file))).toBe(false);
  const answer = execFileSync(process.execPath, ["--require", preload, output], { cwd: dir, encoding: "utf8", timeout: 5000 });
  expect(JSON.parse(answer.trim())).toEqual({ subject: "copied" });
});

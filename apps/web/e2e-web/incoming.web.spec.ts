import { expect, test } from "@playwright/test";

test("the emitted incoming worker and its HTML dependencies cold-load from the offline precache", async ({ page, context }) => {
  await page.goto("/?demo=1&mailbox=incoming-offline-synthetic");
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const workerUrl = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (const name of await caches.keys()) {
      if (!name.startsWith("terno-")) continue;
      for (const request of await (await caches.open(name)).keys()) {
        if (/\/incoming\.worker-[^/]+\.js$/.test(new URL(request.url).pathname)) return request.url;
      }
    }
    return null;
  });
  expect(workerUrl).not.toBeNull();
  await context.setOffline(true);
  try {
    await page.reload();
    await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await page.evaluate((url) => new Promise((resolve, reject) => {
        const worker = new Worker(url!, { type: "module" });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("Offline incoming worker did not answer")); }, 15_000);
        const fail = () => { clearTimeout(timer); worker.terminate(); reject(new Error("Offline incoming worker failed")); };
        worker.onerror = (event) => { event.preventDefault(); fail(); };
        worker.onmessageerror = fail;
        const mime = ['From: sender@test.com', 'Subject: offline incoming', 'Content-Type: multipart/mixed; boundary="p"', '', '--p', 'Content-Type: text/html; charset=utf-8', '', '<b>offline café</b>', '--p', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="binary.bin"', 'Content-Transfer-Encoding: base64', '', 'AP+A', '--p--', ''].join('\r\n');
        const raw = btoa(String.fromCharCode(...new TextEncoder().encode(mime))).replace(/\+/g, "-").replace(/\//g, "_");
        const bytes = new TextEncoder().encode(JSON.stringify({ id: "expected", threadId: "thread", raw }));
        worker.onmessage = (event) => {
          clearTimeout(timer);
          worker.terminate();
          const reply = event.data;
          if (reply.type !== "result") { reject(new Error("Offline incoming worker returned a failure")); return; }
          resolve({ kind: reply.result.kind, id: reply.result.metadata.id, subject: reply.result.message.subject, text: reply.result.message.text, bytes: [...reply.result.message.attachments[0].bytes], detached: bytes.byteLength === 0 });
        };
        worker.postMessage({ type: "process", incarnation: 1, job: 1, input: { kind: "gmail", expectedId: "expected", chunks: [bytes] } }, [bytes.buffer]);
      }), workerUrl);
      expect(result).toEqual({ kind: "gmail", id: "expected", subject: "offline incoming", text: expect.stringContaining("offline café"), bytes: [0, 255, 128], detached: true });
    }
  } finally { await context.setOffline(false); }
});

import { expect, test } from "@playwright/test";

test("queued Gmail survives worker reload and waits for the same account", async ({ page, context }) => {
  const requests: string[] = [], unexpected: string[] = [], sends: string[] = [];
  let identity = "sender@example.test";
  await context.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.origin + url.pathname === "https://accounts.google.com/gsi/client") return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    const key = `${method} ${url.origin}${url.pathname}`;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
    if ((url.hostname === "gmail.googleapis.com" || url.hostname === "openidconnect.googleapis.com") && method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    requests.push(key);
    let data: object;
    if (key === "GET https://openidconnect.googleapis.com/v1/userinfo") data = { sub: identity, email: identity, email_verified: true };
    else if (key === "GET https://gmail.googleapis.com/gmail/v1/users/me/profile") data = { emailAddress: identity, historyId: "10" };
    else if (key === "GET https://gmail.googleapis.com/gmail/v1/users/me/labels") data = { labels: [] };
    else if (key === "GET https://gmail.googleapis.com/gmail/v1/users/me/messages") data = { messages: [] };
    else if (key === "GET https://gmail.googleapis.com/gmail/v1/users/me/history") data = { historyId: "10" };
    else if (key === "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send") { sends.push(req.postData()!); data = { id: "sent-1", threadId: "thread-1" }; }
    else { unexpected.push(key); return route.abort(); }
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/?demo=0&mailbox=w11-queued");
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
  const workers = page.workers();
  const account = await page.evaluate(() => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "synthetic-token", expiresIn: 64 }));
  await page.evaluate(() => window.__ternoWeb!.client.call("sync.network", { online: false }));
  const queued = await page.evaluate(async (accountId) => {
    const c = window.__ternoWeb!.client;
    const ref = await c.call("attachments.create", { accountId, filename: "bytes.bin", mime: "application/octet-stream", size: 3 });
    await c.call("attachments.append", { accountId, assetId: ref.assetId, index: 0, dataBase64: "AP+A" });
    await c.call("attachments.seal", { accountId, assetId: ref.assetId });
    const send = await c.call("compose.send", { accountId, to: [{ name: "Recipient", email: "recipient@example.test" }], cc: [], bcc: [{ name: "", email: "hidden@example.test" }], subject: "Queued synthetic", bodyText: "Exact queued body", attachments: [ref] });
    return { ...send, ref };
  }, account.id);
  const op = () => page.evaluate(async (id) => (await window.__ternoWeb!.client.call("ops.list", {})).find((o) => o.id === id), queued.opId);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  expect(sends).toHaveLength(0);
  const follower = await context.newPage();
  await follower.goto("/?demo=0&mailbox=w11-queued");
  await follower.waitForTimeout(1800);
  expect(follower.workers()).toHaveLength(0);
  const locks = await page.evaluate(() => navigator.locks.query());
  expect(locks.held?.map((lock) => lock.name)).toEqual(expect.arrayContaining(["terno-backend", "unica-backend"]));
  expect(sends).toHaveLength(0);
  await follower.close();
  // Wait past the broker's one-minute safety margin in this same worker.
  await page.waitForTimeout(4500);
  await page.evaluate(() => window.__ternoWeb!.client.call("sync.network", { online: true }));
  await expect.poll(async () => (await op())?.awaitingAuth).toBe(true);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  expect(sends).toHaveLength(0);
  await page.evaluate(() => window.__ternoWeb!.client.call("sync.network", { online: false }));
  await page.evaluate((accountId) => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "before-reload", expiresIn: 3600, accountId }), account.id);
  expect(sends).toHaveLength(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
  expect(page.workers().some((w) => workers.includes(w))).toBe(false);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  const detail = await page.evaluate((threadId) => window.__ternoWeb!.client.call("threads.get", { threadId }), queued.threadId);
  expect(detail.messages[0]).toMatchObject({ subject: "Queued synthetic", bodyText: "Exact queued body" });
  expect(await page.evaluate(({ accountId, assetId }) => window.__ternoWeb!.client.call("attachments.read", { accountId, assetId, index: 0 }), { accountId: account.id, assetId: queued.ref.assetId })).toEqual({ dataBase64: "AP+A" });
  await expect.poll(async () => (await op())?.awaitingAuth).toBe(true);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  const beforeQuiet = requests.length;
  await page.waitForTimeout(3000);
  expect(requests.length).toBe(beforeQuiet);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  await page.evaluate(async () => {
    const settings = await window.__ternoWeb!.client.call("settings.update", { gmailClientId: "123-synthetic.apps.googleusercontent.com" });
    const { setApp } = await import("/src/state/app.ts");
    setApp({ settings });
    window.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => config.error_callback?.({ type: "popup_closed" }) }) } } };
  });
  const beforeRefusal = requests.length;
  expect(await page.evaluate(async ({ email, id }) => {
    const { connectGmailWeb } = await import("/src/web/google.ts");
    return connectGmailWeb(email, id).then(() => "unexpected success", () => "refused");
  }, account)).toBe("refused");
  expect(requests.length).toBe(beforeRefusal);
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  identity = "other@example.test";
  await expect(page.evaluate((accountId) => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "other-token", expiresIn: 3600, accountId }), account.id)).rejects.toThrow();
  expect(await op()).toMatchObject({ state: "queued", attempts: 0 });
  expect(sends).toHaveLength(0);
  identity = "sender@example.test";
  await page.evaluate((accountId) => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "new-token", expiresIn: 3600, accountId }), account.id);
  await expect.poll(() => sends.length).toBe(1);
  await expect.poll(async () => (await op())?.state).toBe("succeeded");
  const mime = Buffer.from(JSON.parse(sends[0]!).raw, "base64url").toString();
  expect(mime).toContain("Queued synthetic"); expect(mime).toContain(Buffer.from("Exact queued body").toString("base64")); expect(mime).toContain("AP+A"); expect(mime).toContain("hidden@example.test");
  await page.reload(); await expect.poll(() => page.evaluate(() => window.__ternoWeb?.storage)).toBe("opfs-sqlite");
  await page.evaluate((accountId) => window.__ternoWeb!.client.call("accounts.connectGmailToken", { accessToken: "last-token", expiresIn: 3600, accountId }), account.id);
  await page.evaluate((accountId) => window.__ternoWeb!.client.call("sync.now", { accountId, reason: "user" }), account.id);
  await page.waitForTimeout(2000);
  expect(sends).toHaveLength(1); expect(unexpected).toEqual([]); expect(requests.length).toBeLessThan(30);
});

test("a legacy lock holder prevents a second mailbox owner", async ({ page, context }) => {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/lock-holder") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Lock holder</title>" });
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto("/lock-holder");
  await page.evaluate(() => new Promise<void>((resolve) => {
    void navigator.locks.request("unica-backend", async () => {
      resolve();
      await new Promise<void>((release) => Object.assign(window, { releaseLegacy: release }));
    });
  }));
  const follower = await context.newPage();
  await follower.goto("/?demo=0&mailbox=w11-legacy");
  await follower.waitForTimeout(1800);
  expect(follower.workers()).toHaveLength(0);
  await page.evaluate(() => (window as Window & { releaseLegacy: () => void }).releaseLegacy());
  await expect.poll(() => follower.evaluate(() => window.__ternoWeb?.storage), { timeout: 20_000 }).toBe("opfs-sqlite");
  expect(follower.workers()).toHaveLength(1);
});

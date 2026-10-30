import { expect, test } from "@playwright/test";

test("browser GIS callbacks retain an authored draft in the actual worker store", async ({ page, context }) => {
  const unexpected: string[] = [];
  const provider: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.hostname === "gmail.googleapis.com" || url.hostname === "openidconnect.googleapis.com") {
      provider.push(url.hostname + url.pathname);
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const data = url.hostname === "openidconnect.googleapis.com" ? { sub: "synthetic-sub", email_verified: true } : url.pathname.endsWith("/profile") ? { emailAddress: "luis.cordero@gmail.com", historyId: "10" } : { messages: [] };
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(data) });
    }
    unexpected.push(url.origin + url.pathname);
    return route.abort();
  });
  await page.addInitScript(() => {
    const w = window as Window & { outcome: string; submissions: number };
    w.outcome = "popup_closed"; w.submissions = 0;
    w.google = { accounts: { oauth2: { initTokenClient: (config) => ({ requestAccessToken: () => {
      w.submissions++;
      if (w.outcome.startsWith("popup_")) config.error_callback?.({ type: w.outcome });
      else if (w.outcome === "valid") config.callback({ access_token: "synthetic-token", expires_in: 3599, scope: "openid email profile https://www.googleapis.com/auth/gmail.modify" });
      else config.callback({ error: w.outcome });
    } }) } } };
  });
  await page.goto("/?demo=200&mailbox=w12-gis");
  await page.getByTestId("thread-row").first().waitFor({ timeout: 60_000 });
  expect(await page.evaluate(() => window.__ternoWeb!.storage)).toBe("opfs-sqlite");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-accounts").click();
  const id = page.getByRole("textbox", { name: "Google OAuth Client ID" });
  await id.fill("123-synthetic.apps.googleusercontent.com"); await id.blur();
  await page.keyboard.press("Escape");
  const list = page.getByRole("listbox", { name: "Conversations" });
  await list.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByTestId("compose-to").fill("author@example.test");
  await page.getByTestId("compose-to").press("Enter");
  await page.getByTestId("compose-subject").fill("Synthetic recovery subject");
  await page.getByTestId("attachment-input").setInputFiles({ name: "bytes.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 255, 128]) });
  const body = page.getByTestId("compose-body"); await body.fill("Synthetic authored body");
  await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
  await body.press("ArrowLeft"); await body.press("Shift+ArrowLeft");
  const snapshot = () => page.evaluate(() => ({ text: document.querySelector('[data-testid="compose-body"]')!.innerHTML, subject: document.querySelector<HTMLInputElement>('[data-testid="compose-subject"]')!.value, active: document.activeElement?.getAttribute("data-testid"), anchor: getSelection()!.anchorOffset, focus: getSelection()!.focusOffset, selected: getSelection()!.toString(), scroll: document.querySelector<HTMLElement>('[data-keep-scroll="list"]')!.scrollTop }));
  const before = await snapshot();
  expect(before.anchor).toBeGreaterThan(before.focus);
  const draft = (await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]!;
  expect(draft).toMatchObject({ subject: "Synthetic recovery subject", bodyText: "Synthetic authored body" });
  expect(draft.attachments).toHaveLength(1);
  expect(await page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), draft)).toEqual({ dataBase64: "AP+A" });
  const account = await page.evaluate(async () => (await window.__ternoWeb!.client.call("app.bootstrap", {})).accounts[0]!);
  const invoke = async (outcome: string) => page.evaluate(async ({ outcome, account }) => {
    (window as Window & { outcome: string }).outcome = outcome;
    const { connectGmailWeb } = await import("/src/web/google.ts");
    return connectGmailWeb(account.email, account.id).then(() => "success", (e: Error) => e.message);
  }, { outcome, account });
  for (const outcome of ["popup_closed", "popup_failed_to_open", "access_denied", "admin_policy_enforced"]) {
    expect(await invoke(outcome)).not.toBe("success");
    expect(await snapshot()).toEqual(before);
  }
  expect(provider).toEqual([]);
  expect(await invoke("valid")).toBe("success");
  expect(await page.evaluate(() => (window as Window & { submissions: number }).submissions)).toBe(5);
  expect(provider).toContain("gmail.googleapis.com/gmail/v1/users/me/profile");
  expect(await snapshot()).toEqual(before);
  expect((await page.evaluate(() => window.__ternoWeb!.client.call("drafts.list", {})))[0]).toEqual(draft);
  expect(await page.evaluate((d) => window.__ternoWeb!.client.call("attachments.read", { accountId: d.accountId, assetId: d.attachments![0]!.assetId, index: 0 }), draft)).toEqual({ dataBase64: "AP+A" });
  expect(unexpected).toEqual([]);
});

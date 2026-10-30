import { expect, type Page } from "@playwright/test";
import type { Draft } from "@terno/core/rpc";

export async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/lib/drafts.ts";
    const m = await import(/* @vite-ignore */ path) as typeof import("../src/lib/drafts");
    const d = Object.values(m.useDrafts.getState().drafts).find((d) => d.uiState === "open")!;
    const { accountId, toText, ccText, bccText, auto, subject, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, replyContext, mode } = d;
    return { accountId, toText, ccText, bccText, auto, subject, quotedText, includeQuote, inReplyToMessageId, forwardOfMessageId, replyContext, mode };
  });
}

export async function rows(page: Page): Promise<Draft[]> {
  return page.evaluate(async () => {
    const path = "/src/rpc/connection.ts";
    const { client } = await import(/* @vite-ignore */ path) as typeof import("../src/rpc/connection");
    return client.call("drafts.list", {});
  });
}

export async function switches(page: Page, accounts: { id: number; email: string; signature: string }[]) {
  const body = page.getByTestId("compose-body");
  await expect(page.getByTestId("compose-from")).toContainText(accounts[0]!.email);
  await expect(page.getByTestId("compose-signature")).toHaveText("-- \nSignature A");
  await body.fill("Authored Signature A ");
  await body.press("End"); await body.press("ControlOrMeta+b"); await page.keyboard.type("bold"); await body.press("ControlOrMeta+b");
  await expect.poll(async () => (await rows(page)).some((r) => r.bodyText === "Authored Signature A bold")).toBe(true);
  const baseline = (await rows(page)).find((r) => r.bodyText === "Authored Signature A bold")!;
  const before = await snapshot(page);
  const node = await body.elementHandle();
  const html = await body.innerHTML();
  await armSaveGate(page);
  await body.press("End"); await page.keyboard.type(" pending");
  await expect.poll(() => page.evaluate(() => (window as unknown as { w09Gate: { entered: boolean } }).w09Gate.entered)).toBe(true);
  const mountedHtml = await body.innerHTML();
  for (const index of [1, 0, 1]) {
    const account = accounts[index]!;
    await page.getByTestId("compose-from").focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.getByRole("option").filter({ hasText: account.email }).press("Enter");
    await expect(page.getByTestId("compose-from")).toContainText(account.email);
    if (account.signature.trim()) await expect(page.getByTestId("compose-signature")).toHaveText(`-- \n${account.signature.replace(/\s+$/, "")}`);
    else await expect(page.getByTestId("compose-signature")).toHaveCount(0);
    expect(await snapshot(page)).toEqual({ ...before, accountId: account.id });
    await expect(body).toHaveText("Authored Signature A bold pending");
    expect(await body.innerHTML()).toBe(mountedHtml);
    expect(await body.evaluate((el, old) => el === old, node)).toBe(true);
    expect(await rows(page)).toEqual([baseline]);
  }
  expect(html).toContain("bold");
  const proof = await page.evaluate(async () => {
    const path = "/src/lib/drafts.ts";
    const m = await import(/* @vite-ignore */ path) as typeof import("../src/lib/drafts");
    const d = Object.values(m.useDrafts.getState().drafts).find((d) => d.uiState === "open")!;
    return { dirty: d.localRev > d.savedRev, saved: await m.draftsSaved(10), sends: (window as unknown as { w09Gate: { sends: number } }).w09Gate.sends };
  });
  expect(proof).toEqual({ dirty: true, saved: false, sends: 0 });
  await page.evaluate(() => (window as unknown as { w09Gate: { release(): void } }).w09Gate.release());
  await expect.poll(async () => (await rows(page))[0]?.accountId).toBe(accounts[1]!.id);
  await expect.poll(async () => (await rows(page))[0]?.bodyText).toBe("Authored Signature A bold pending");
  const saved = (await rows(page))[0]!;
  expect(saved).toMatchObject({ id: baseline.id, generation: baseline.generation, accountId: accounts[1]!.id, bodyText: "Authored Signature A bold pending", bodyHtml: "<div>Authored Signature A <b>bold</b> pending</div>", quotedText: before.quotedText, includeQuote: before.includeQuote, subject: before.subject, mode: before.mode });
  await expect(body).toHaveText(saved.bodyText);
  expect(await body.innerHTML()).toBe(mountedHtml);
  expect(await body.evaluate((el, old) => el === old, node)).toBe(true);
  await expect.poll(() => page.evaluate(async (row) => {
    const path = "/src/lib/drafts.ts";
    const m = await import(/* @vite-ignore */ path) as typeof import("../src/lib/drafts");
    const d = Object.values(m.useDrafts.getState().drafts).find((d) => d.id === row.id)!;
    return d.status === "saved" && d.savedRev === d.localRev && d.generation === row.generation && d.revision === row.revision && !d.sending;
  }, saved)).toBe(true);
  await node?.dispose();
  await page.reload(); await page.locator("[data-ready]").waitFor();
  expect(await rows(page)).toEqual([saved]);
  const strip = page.locator(`[data-testid="strip-item"][data-key="srv-${saved.id}"]`);
  await body.or(strip).first().waitFor();
  if (!await body.isVisible()) await strip.click();
  await expect(body).toHaveText(saved.bodyText);
  await expect(page.getByTestId("compose-from")).toContainText(accounts[1]!.email);
  return { saved, before };
}

export async function armSaveGate(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/rpc/connection.ts";
    const { client } = await import(/* @vite-ignore */ path) as typeof import("../src/rpc/connection");
    const call = client.call.bind(client);
    const gate: { entered: boolean; release?: () => void; sends: number } = { entered: false, sends: 0 };
    Object.assign(window, { w09Gate: gate });
    Object.defineProperty(client, "call", { configurable: true, value: (...args: Parameters<typeof call>) => {
      if (args[0] === "compose.send") gate.sends++;
      if (args[0] !== "drafts.save" || gate.entered) return call(...args);
      gate.entered = true;
      return new Promise<void>((resolve) => { gate.release = resolve; }).then(() => call(...args));
    } });
  });
}

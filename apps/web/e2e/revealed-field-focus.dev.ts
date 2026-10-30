import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { SendPayload } from "@terno/mail";
import { parseRaw } from "@terno/mail";
import { addRecipients, expect, recipientEmails, test } from "./browser-forward-fixtures";

async function holdReveal(page: Page) {
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const held = new Map<number, FrameRequestCallback>(); let id = -1, queued = 0;
      window.requestAnimationFrame = (cb) => {
        if (new Error().stack?.includes("inline-draft.tsx")) { queued++; held.set(--id, cb); return id; }
        return raf(cb);
      };
      window.cancelAnimationFrame = (id) => { if (id < 0) held.delete(id); else cancel(id); };
      Object.assign(window, { revealQueued: () => queued, releaseReveal: () => {
        window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel;
        for (const cb of held.values()) raf(cb); held.clear();
        return new Promise<void>((resolve) => raf(() => raf(() => resolve())));
      } });
    });
}

test.use({ backendOptions: { smtpCapture: true } });
for (const language of ["en", "es"] as const) for (const theme of ["light", "dark"] as const) for (const field of ["cc", "bcc"] as const) for (const successor of ["subject", "body", "to", "none", "pointer"] as const) {
  test(`revealed ${field}: later ${successor} wins (${language}, ${theme})`, async ({ app: page, server }, info) => {
    await server.backend.server.invoke("settings.update", { language, theme }, { clientId: "reveal", origin: "dev" });
    const submissions: { subject: string; bodyText: string; to: { email: string }[]; cc: { email: string }[]; bcc: { email: string }[] }[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.t === "req" && frame.m === "compose.send") submissions.push(frame.p);
    }));
    await page.reload(); await page.locator("[data-ready]").waitFor();
    await page.getByTestId("compose-button").click();
    await addRecipients(page, "compose-to", "Target <target@example.test>");
    const subject = page.getByTestId("compose-subject"), body = page.getByTestId("compose-body");
    await subject.fill("Subject baseline"); await body.fill("Body baseline");
    // Formatting commands create native history boundaries without changing the baseline.
    await body.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+b"); await page.keyboard.press("ControlOrMeta+b");
    await expect(body.locator("b, strong")).toHaveCount(0);
    // Hold only this feature's callback; release onto the browser's actual next frame.
    await holdReveal(page);
    const toggle = page.getByTestId(`compose-show-${field}`);
    if (successor === "none") { await toggle.focus(); await page.keyboard.press("Enter"); }
    else await toggle.click();
    expect(await page.evaluate(() => (window as unknown as { revealQueued(): number }).revealQueued())).toBe(1);
    const target = page.getByTestId(`compose-${(successor === "none" || successor === "pointer") ? field : successor}`);
    if ((successor !== "none" && successor !== "pointer")) {
      await target.click();
      if (successor !== "to") {
        await page.keyboard.press("End"); await page.keyboard.press("Shift+ArrowLeft");
        await page.keyboard.press("Shift+ArrowLeft");
      }
    }
    const selection = await target.evaluate((el) => el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : [window.getSelection()?.anchorOffset, window.getSelection()?.focusOffset, window.getSelection()?.toString()]);
    await page.evaluate(() => (window as unknown as { releaseReveal(): Promise<void> }).releaseReveal());
    await expect(target).toBeFocused();
    if ((successor !== "none" && successor !== "pointer")) expect(await target.evaluate((el) => el instanceof HTMLInputElement ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : [window.getSelection()?.anchorOffset, window.getSelection()?.focusOffset, window.getSelection()?.toString()])).toEqual(selection);
    if (successor === "subject" || successor === "body") {
      await page.keyboard.type("XY");
      if (successor === "subject") await expect(subject).toHaveValue("Subject baseliXY");
      else await expect(body).toHaveText("Body baseliXY");
      await page.keyboard.press("ControlOrMeta+z");
      if (successor === "subject") await expect(subject).toHaveValue("Subject baseline");
      else await expect(body).toHaveText("Body baseline");
    } else if (successor === "to") {
      await page.keyboard.type("Other <other@example.test>"); await page.keyboard.press("Enter");
    } else {
      await page.keyboard.type("Private <private@example.test>"); await page.keyboard.press("Enter");
    }
    const to = await recipientEmails(page, "compose-to");
    const cc = field === "cc" && (successor === "none" || successor === "pointer") ? ["private@example.test"] : [];
    const bcc = field === "bcc" && (successor === "none" || successor === "pointer") ? ["private@example.test"] : [];
    expect(to).toEqual(successor === "to" ? ["target@example.test", "other@example.test"] : ["target@example.test"]);
    expect(await recipientEmails(page, `compose-${field}`)).toEqual((successor === "none" || successor === "pointer") ? ["private@example.test"] : []);
    expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').analyze()).violations).toEqual([]);
    if (field === "bcc" && successor === "subject") await page.screenshot({ path: info.outputPath(`${language}-${theme}.png`) });
    await page.getByTestId("compose-send").click();
    await expect.poll(() => server.smtp.length).toBe(1);
    expect(server.smtp[0]!.rcpt).toEqual([...to, ...cc, ...bcc]);
    const mail = await parseRaw(server.smtp[0]!.raw);
    expect(mail.subject).toBe("Subject baseline"); expect(mail.text?.trim()).toBe("Body baseline");
    expect(mail.to.map((r) => r.email)).toEqual(to); expect(mail.cc.map((r) => r.email)).toEqual(cc); expect(mail.bcc).toEqual([]);
    const ops = (await server.backend.store.debug.snapshot()).ops.filter((op) => op.kind === "send");
    expect(ops).toHaveLength(1);
    const payload = JSON.parse((await server.backend.store.ops.get(ops[0]!.id))!.payload_json) as SendPayload;
    expect(payload.subject).toBe("Subject baseline"); expect(payload.text.trim()).toBe("Body baseline");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ subject: "Subject baseline", bodyText: "Body baseline" });
    for (const key of ["to", "cc", "bcc"] as const) {
      expect(payload[key].map((r) => r.email)).toEqual({ to, cc, bcc }[key]);
      expect(submissions[0]![key].map((r) => r.email)).toEqual({ to, cc, bcc }[key]);
    }
  });
}

for (const key of ["Tab", "Shift+Tab"] as const) test(`later native ${key} cancels reveal`, async ({ app: page }) => {
  await page.getByTestId("compose-button").click();
  await expect(page.getByTestId("compose-body")).toBeVisible();
  await holdReveal(page);
  await page.getByTestId("compose-show-bcc").focus(); await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { revealQueued(): number }).revealQueued())).toBe(1);
  await page.keyboard.press(key);
  const chosen = await page.evaluateHandle(() => document.activeElement);
  expect(await chosen.evaluate((el) => el !== document.body)).toBe(true);
  await page.evaluate(() => (window as unknown as { releaseReveal(): Promise<void> }).releaseReveal());
  expect(await chosen.evaluate((el) => el === document.activeElement)).toBe(true);
  await chosen.dispose();
});

test("Subject reveal retains ordinary keyboard intention", async ({ app: page }) => {
  const { openRow, focusList } = await import("./fixtures");
  await openRow(page, 0); await focusList(page); await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  const toggle = page.getByTestId("compose-show-subject");
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("compose-subject")).toBeFocused();
  await page.keyboard.press("End"); await page.keyboard.type(" amended");
  await expect(page.getByTestId("compose-subject")).toHaveValue(/ amended$/);
});

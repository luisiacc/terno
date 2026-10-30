import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { AttachmentRef } from "@terno/core";
import { addRecipients, chipsOf, expect, test } from "./fixtures";

test.use({ backendOptions: { network: true }, layout: "split" });

const ctx = { clientId: "background-sign-in", origin: "dev" as const };
const text = "Recovery keeps this exact message.";
const subject = "Auth recovery continuity";
const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);

// Read only: neither the oracle nor its settled-state wait repairs focus/selection or publishes renderer state.
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-testid="compose-body"]')!;
    const list = document.querySelector<HTMLElement>('[data-keep-scroll="list"]')!;
    const selection = getSelection()!;
    return {
      body: body.innerHTML,
      subject: document.querySelector<HTMLInputElement>('[data-testid="compose-subject"]')!.value,
      recipients: ["to", "cc", "bcc"].map((field) => {
        const root = document.querySelector(`[data-testid="compose-${field}-field"]`)!;
        return {
          chips: [...root.querySelectorAll<HTMLElement>('[data-testid="recipient-chip"]')].map((el) => ({ email: el.dataset.email, text: el.textContent, invalid: el.getAttribute("aria-invalid") })),
          input: root.querySelector("input")!.value,
        };
      }),
      attachments: [...document.querySelectorAll('[data-testid="draft-attachment"]')].map((el) => el.textContent),
      from: document.querySelector('[data-testid="compose-from"]')!.textContent,
      key: document.querySelector("[data-draft-key]")!.getAttribute("data-draft-key"),
      scroll: list.scrollTop,
      cursor: list.getAttribute("aria-activedescendant"),
      selected: document.querySelector('[data-testid="thread-row"][data-cursor]')?.getAttribute("data-thread-id"),
      visibleAnchor: [...list.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].filter((el) => el.getBoundingClientRect().bottom > list.getBoundingClientRect().top).slice(0, 1).map((el) => ({ id: el.dataset.threadId, top: el.getBoundingClientRect().top - list.getBoundingClientRect().top })),
      focus: document.activeElement === body ? "body" : document.activeElement === list ? "list" : document.activeElement?.outerHTML,
      selection: { anchor: selection.anchorOffset, focus: selection.focusOffset, anchorText: selection.anchorNode?.textContent, focusText: selection.focusNode?.textContent, text: selection.toString() },
      tabRing: document.documentElement.hasAttribute("data-focus-ring"),
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const placement of ["caret", "backward selection", "list focus"] as const) {
    test(`background OAuth recovery preserves authored composer and ${placement} (${theme}) @design`, async ({ app: page, server }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const account = (await server.backend.store.accounts.list()).find((a) => a.kind === "gmail")!;
      await server.backend.server.invoke("settings.update", { gmailClientId: "e2e.apps.googleusercontent.com" }, ctx);
      const list = page.getByRole("listbox", { name: "Conversations" });
      await list.hover();
      await page.mouse.wheel(0, 850);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      const visibleId = await list.evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find((row) => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)?.dataset.threadId);
      await page.locator(`[data-testid="thread-row"][data-thread-id="${visibleId}"]`).click();
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await page.getByTestId("compose-button").click();
      await expect(page.getByTestId("compose-from")).toContainText(account.email);
      await addRecipients(page, "compose-to", '"Author, Ana" <ana@example.test>');
      await page.getByTestId("compose-to").pressSequentially("unfinished@");
      await page.getByTestId("compose-show-cc").click();
      await expect(page.getByTestId("compose-cc")).toBeFocused();
      await addRecipients(page, "compose-cc", "copy@example.test");
      await page.getByTestId("compose-show-bcc").click();
      await expect(page.getByTestId("compose-bcc")).toBeFocused();
      await addRecipients(page, "compose-bcc", "blind@example.test");
      await page.getByTestId("compose-subject").pressSequentially(subject);
      await page.getByTestId("attachment-input").setInputFiles({ name: "recovery.bin", mimeType: "application/octet-stream", buffer: bytes });
      await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
      const body = page.getByTestId("compose-body");
      await body.click();
      await page.keyboard.type(text);
      await expect(body).toHaveText(text);
      await expect(page.getByTestId("compose-subject")).toHaveValue(subject);
      await expect(chipsOf(page, "compose-to").first()).toHaveAttribute("data-email", "ana@example.test");
      // Blur commits the unfinished recipient as its own invalid chip, without dropping it.
      await expect(chipsOf(page, "compose-to")).toHaveCount(2);
      await expect(chipsOf(page, "compose-to").nth(1)).toHaveAttribute("data-email", "unfinished@");
      await expect(chipsOf(page, "compose-to").nth(1)).toHaveAttribute("aria-invalid", "true");
      await expect(chipsOf(page, "compose-cc")).toHaveAttribute("data-email", "copy@example.test");
      await expect(chipsOf(page, "compose-bcc")).toHaveAttribute("data-email", "blind@example.test");
      await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
      const saved = (await server.backend.store.drafts.list())[0]!;
      expect(saved).toMatchObject({ account_id: account.id, body_text: text, subject });
      const refs: AttachmentRef[] = JSON.parse(saved.attachments_json);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ filename: "recovery.bin", size: bytes.length });
      expect(await server.backend.store.attachments.read(account.id, refs[0]!.assetId, 0)).toBe(bytes.toString("base64"));

      await body.press("ArrowLeft");
      if (placement === "backward selection") {
        for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
      } else if (placement === "list focus") {
        await page.getByTestId("strip-item").focus();
        // The draft strip immediately precedes the real listbox in keyboard order.
        await page.keyboard.press("Tab");
        await expect(list).toBeFocused();
      }
      const before = await snapshot(page);
      expect(before.scroll).toBeGreaterThan(0);
      expect(before.focus).toBe(placement === "list focus" ? "list" : "body");
      if (placement !== "list focus") {
        expect(before.selection.anchor).toBe(text.length - 1);
        expect(before.selection.focus).toBe(text.length - (placement === "caret" ? 1 : 6));
        expect(before.tabRing).toBe(false);
      } else {
        expect(before.cursor).toBeTruthy();
        expect(before.tabRing).toBe(true);
        await expect(list).toHaveCSS("outline-style", "none");
        await expect(list).toHaveCSS("box-shadow", "none");
      }
      const nodes = await page.evaluateHandle(() => ({
        form: document.querySelector('[data-testid="composer"]'),
        body: document.querySelector('[data-testid="compose-body"]'),
        subject: document.querySelector('[data-testid="compose-subject"]'),
        recipients: ["to", "cc", "bcc"].map((field) => document.querySelector(`[data-testid="compose-${field}"]`)),
        list: document.querySelector('[data-keep-scroll="list"]'),
        active: document.activeElement,
        anchor: getSelection()!.anchorNode,
        focus: getSelection()!.focusNode,
      }));

      server.net.refused.add(account.email);
      await server.backend.syncAccount(account.id);
      await expect(page.getByTestId(`sign-in-marker-${account.id}`)).toBeVisible();
      expect(await snapshot(page)).toEqual(before);
      // A sign-in completed by another window uses the real RPC handler and synthetic OAuth provider.
      await server.backend.server.invoke("accounts.reconnect", { id: account.id }, ctx);
      await expect.poll(async () => (await server.backend.store.accounts.get(account.id))!.syncState).toMatchObject({ authRequired: false, status: "idle" });
      await expect(page.getByTestId(`sign-in-marker-${account.id}`)).toHaveCount(0);
      await page.waitForFunction((id) => {
        const hooks = window as unknown as { __terno: { getApp(): { accounts: { id: number; syncState: { status: string; authRequired?: boolean } }[] } } };
        const state = hooks.__terno.getApp().accounts.find((a) => a.id === id)?.syncState;
        return state?.status === "idle" && !state.authRequired;
      }, account.id);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await snapshot(page)).toEqual(before);
      expect(await page.evaluate((old) => ({
        form: old.form === document.querySelector('[data-testid="composer"]'),
        body: old.body === document.querySelector('[data-testid="compose-body"]'),
        subject: old.subject === document.querySelector('[data-testid="compose-subject"]'),
        recipients: old.recipients.every((el, i) => el === document.querySelector(`[data-testid="compose-${["to", "cc", "bcc"][i]}"]`)),
        list: old.list === document.querySelector('[data-keep-scroll="list"]'),
        active: old.active === document.activeElement,
        anchor: old.anchor === getSelection()!.anchorNode,
        focus: old.focus === getSelection()!.focusNode,
      }), nodes)).toEqual({ form: true, body: true, subject: true, recipients: true, list: true, active: true, anchor: true, focus: true });
      expect(await server.backend.store.drafts.list()).toEqual([saved]);
      expect(await server.backend.store.attachments.read(account.id, refs[0]!.assetId, 0)).toBe(bytes.toString("base64"));
      await page.screenshot({ path: info.outputPath(`recovered-${theme}.png`) });
      expect((await new AxeBuilder({ page }).include('[data-testid="composer"]').include('[data-testid="thread-list"]').analyze()).violations).toEqual([]);
      if (placement !== "list focus") {
        await page.keyboard.type("X");
        const end = text.length - 1;
        const start = placement === "caret" ? end : end - 5;
        const edited = text.slice(0, start) + "X" + text.slice(end);
        await expect(body).toHaveText(edited);
        await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.body_text).toBe(edited);
      }
      await nodes.dispose();
    });
  }
}

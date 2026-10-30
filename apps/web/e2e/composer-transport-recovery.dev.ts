import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { AttachmentRef } from "@terno/core";
import type { Draft } from "@terno/core/rpc";
import { addRecipients, chipsOf, expect, selectThread } from "./fixtures";
import { test } from "./transport-fixture";

test.use({ layout: "split" });
const ctx = { clientId: "transport-observer", origin: "dev" as const };
const originalText = "Transport keeps this authored message.";
const text = `${originalText} Unsaved.`;
const subject = "Transport continuity";
const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);

async function local(page: Page) {
  return page.evaluate(async () => {
    const url = "/src/lib/drafts.ts";
    const { useDrafts }: typeof import("../src/lib/drafts") = await import(url);
    const key = document.querySelector("[data-draft-key]")!.getAttribute("data-draft-key")!;
    const d = useDrafts.getState().drafts[key]!;
    const rpcUrl = "/src/rpc/connection.ts";
    const { client }: typeof import("../src/rpc/connection") = await import(rpcUrl);
    return {
      id: d.id, generation: d.generation, revision: d.revision, localRev: d.localRev, savedRev: d.savedRev,
      status: d.status, recovery: d.recovery, held: useDrafts.getState().held, pending: client.pendingCount,
      context: { accountId: d.accountId, threadId: d.threadId, mode: d.mode, source: d.inReplyToMessageId,
        showSourceContext: d.showSourceContext, presentationThreadId: d.presentationThreadId,
        sourceContextThreadId: d.sourceContextThreadId, presentationEpoch: d.presentationEpoch, presentationExpired: d.presentationExpired },
      attachments: d.attachments,
    };
  });
}

// Passive reads only throughout the disconnected interval: no materialize, focus or later state setter.
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
        return { chips: [...root.querySelectorAll<HTMLElement>('[data-testid="recipient-chip"]')].map((el) => ({ email: el.dataset.email, text: el.textContent, invalid: el.getAttribute("aria-invalid") })), input: root.querySelector("input")!.value };
      }),
      attachments: [...document.querySelectorAll('[data-testid="draft-attachment"]')].map((el) => el.textContent),
      from: document.querySelector('[data-testid="compose-from"]')!.textContent,
      key: document.querySelector("[data-draft-key]")!.getAttribute("data-draft-key"),
      scroll: list.scrollTop, cursor: list.getAttribute("aria-activedescendant"),
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
    test(`MessagePort replacement retains unsaved reply and ${placement} (${theme})`, async ({ app: page, server }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const list = page.getByRole("listbox", { name: "Conversations" });
      await list.hover(); await page.mouse.wheel(0, 850);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      const id = await list.evaluate((el) => [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')].find((row) => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)!.dataset.threadId!);
      await page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`).click();
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      const source = await server.backend.server.invoke("threads.get", { threadId: Number(id) }, ctx);
      await page.getByTestId("quick-reply").click();
      const body = page.getByTestId("compose-body");
      await expect(body).toBeFocused();
      await page.getByTestId("compose-show-subject").click();
      await expect(page.getByTestId("compose-subject")).toBeFocused();
      await page.getByTestId("compose-subject").fill(subject);
      await addRecipients(page, "compose-to", '"Author, Ana" <ana@example.test>');
      await page.getByTestId("compose-show-cc").click(); await expect(page.getByTestId("compose-cc")).toBeFocused(); await addRecipients(page, "compose-cc", "copy@example.test");
      await page.getByTestId("compose-show-bcc").click(); await expect(page.getByTestId("compose-bcc")).toBeFocused(); await addRecipients(page, "compose-bcc", "blind@example.test");
      await page.getByTestId("attachment-input").setInputFiles({ name: "transport.bin", mimeType: "application/octet-stream", buffer: bytes });
      await expect(page.getByTestId("draft-attachment")).toHaveCount(1);
      await body.click(); await page.keyboard.type(originalText);
      await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
      const baseline = (await server.backend.server.invoke("drafts.list", {}, ctx))[0]!;
      expect(baseline).toMatchObject({ threadId: Number(id), mode: "reply", bodyText: originalText, subject });
      expect(source.messages.some((m) => m.id === baseline.inReplyToMessageId && m.accountId === baseline.accountId)).toBe(true);
      const account = (await server.backend.store.accounts.list()).find((a) => a.id === baseline.accountId)!;
      await expect(page.getByTestId("compose-from")).toContainText(account.email);
      const refs: AttachmentRef[] = baseline.attachments!;
      expect(refs).toHaveLength(1);
      expect(await server.backend.store.attachments.read(account.id, refs[0]!.assetId, 0)).toBe(bytes.toString("base64"));

      await page.evaluate(() => window.__transport.blockSave());
      await page.getByTestId("compose-to").pressSequentially("unfinished@");
      await page.getByTestId("compose-subject").press("End"); await page.keyboard.type(" unsaved");
      await body.click(); await body.press("End"); await page.keyboard.type(" Unsaved.");
      await expect(chipsOf(page, "compose-to").last()).toHaveAttribute("data-email", "unfinished@");
      await expect(body).toHaveText(text);
      await expect.poll(() => page.evaluate(() => window.__transport.records.filter((r) => r.kind === "blocked").length)).toBe(1);
      const blocked = (await page.evaluate(() => window.__transport.records.find((r) => r.kind === "blocked")))!;
      expect(blocked.epoch).toBe(1);
      expect(blocked.frame?.t).toBe("req");
      expect(blocked.frame && "p" in blocked.frame ? blocked.frame.p : null).toMatchObject({ id: baseline.id, generation: baseline.generation, baseRevision: baseline.revision, bodyText: text, bodyHtml: `<div>${text}</div>`, subject: `${subject} unsaved`, attachments: refs });
      expect((await local(page)).pending).toBeGreaterThan(0);
      expect((await local(page)).savedRev).toBeLessThan((await local(page)).localRev);
      expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual([baseline]);
      await body.press("ArrowLeft");
      if (placement === "backward selection") for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
      if (placement === "list focus") {
        await page.getByTestId("compose-button").focus();
        const stops: string[] = [];
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          stops.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "none"));
          if (await list.evaluate((el) => el === document.activeElement)) break;
        }
        const path = info.outputPath("keyboard-list-entry.json");
        writeFileSync(path, JSON.stringify(stops));
        await info.attach("keyboard-list-entry", { path, contentType: "application/json" });
        await expect(list).toBeFocused();
      }
      const before = await snapshot(page), beforeLocal = await local(page);
      expect(before.scroll).toBeGreaterThan(0);
      expect(before.focus).toBe(placement === "list focus" ? "list" : "body");
      expect(before.tabRing).toBe(placement === "list focus");
      if (placement !== "list focus") {
        expect(before.selection.anchor).toBe(text.length - 1);
        expect(before.selection.focus).toBe(text.length - (placement === "caret" ? 1 : 6));
      }
      const nodes = await page.evaluateHandle(() => ({
        form: document.querySelector('[data-testid="composer"]'), body: document.querySelector('[data-testid="compose-body"]'),
        subject: document.querySelector('[data-testid="compose-subject"]'), list: document.querySelector('[data-keep-scroll="list"]'),
        recipients: ["to", "cc", "bcc"].map((field) => document.querySelector(`[data-testid="compose-${field}"]`)),
        active: document.activeElement, anchor: getSelection()!.anchorNode, focus: getSelection()!.focusNode,
      }));
      const unchanged = async () => {
        expect(await snapshot(page)).toEqual(before);
        expect((await local(page)).context).toEqual(beforeLocal.context);
        expect((await local(page)).attachments).toEqual(refs);
        expect((await local(page)).held).toBe(false);
        expect((await local(page)).recovery).toBeUndefined();
        expect(await page.evaluate((old) => [
          old.form === document.querySelector('[data-testid="composer"]'), old.body === document.querySelector('[data-testid="compose-body"]'),
          old.subject === document.querySelector('[data-testid="compose-subject"]'), old.list === document.querySelector('[data-keep-scroll="list"]'),
          old.recipients.every((el, i) => el === document.querySelector(`[data-testid="compose-${["to", "cc", "bcc"][i]}"]`)),
          old.active === document.activeElement, old.anchor === getSelection()!.anchorNode, old.focus === getSelection()!.focusNode,
        ], nodes)).toEqual(Array(8).fill(true));
      };
      await page.evaluate(() => window.__transport.disconnect());
      await expect.poll(() => page.evaluate(() => window.__transport.records.filter((r) => r.kind === "port-closed" && r.epoch === 1).length)).toBe(1);
      await expect.poll(() => page.evaluate(() => window.__transport.records.filter((r) => r.kind === "request-port").length)).toBe(2);
      await expect.poll(async () => (await local(page)).status).toBe("error");
      expect((await local(page)).pending).toBe(0);
      expect((await local(page)).savedRev).toBe(beforeLocal.savedRev);
      expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual([baseline]);
      await unchanged();
      await page.evaluate(() => window.__transport.replace());
      await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await unchanged();
      const recovered = (await server.backend.server.invoke("drafts.list", {}, ctx))[0]!;
      expect(recovered).toMatchObject({ ...baseline, revision: baseline.revision + 1, bodyText: text, bodyHtml: `<div>${text}</div>`, subject: `${subject} unsaved`, to: [...baseline.to, { email: "unfinished@", name: "" }] });
      const afterLocal = await local(page);
      expect(afterLocal).toMatchObject({ id: baseline.id, generation: baseline.generation, revision: recovered.revision, status: "saved" });
      expect(afterLocal.localRev).toBe(beforeLocal.localRev);
      expect(afterLocal.savedRev).toBe(beforeLocal.localRev);
      const records = await page.evaluate(() => window.__transport.records);
      expect(records.some((r) => r.kind === "request" && r.frame?.id === blocked.frame?.id)).toBe(false);
      expect(records.filter((r) => r.kind === "delivered").map((r) => r.epoch)).toEqual([1, 2]);
      expect(records.some((r) => r.kind === "ws-closed" && r.epoch === 1)).toBe(true);
      const request = records.find((r) => r.epoch === 2 && r.kind === "request" && r.frame?.t === "req" && r.frame.m === "drafts.save")!;
      expect(request.frame!.id).toBeGreaterThan(blocked.frame!.id);
      expect(request.frame && "p" in request.frame ? request.frame.p : null).toEqual(blocked.frame && "p" in blocked.frame ? blocked.frame.p : null);
      expect(records.find((r) => r.epoch === 2 && r.kind === "response" && r.frame?.id === request.frame?.id)?.frame).toMatchObject({ t: "res", ok: true, r: recovered });
      const evidencePath = info.outputPath("transport-epochs.json");
      writeFileSync(evidencePath, JSON.stringify(records, null, 2));
      await info.attach("transport-epochs", { path: evidencePath, contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`recovered-${theme}.png`) });
      expect((await new AxeBuilder({ page }).setLegacyMode().include('[data-testid="composer"]').include('[data-testid="thread-list"]').analyze()).violations).toEqual([]);
      await expect(list).toHaveCSS("outline-style", "none"); await expect(list).toHaveCSS("box-shadow", "none");
      let finalText = text;
      if (placement !== "list focus") {
        await page.keyboard.type("X");
        const end = text.length - 1, start = placement === "caret" ? end : end - 5;
        finalText = text.slice(0, start) + "X" + text.slice(end);
        await expect(body).toHaveText(finalText);
      } else {
        const nextId = await list.evaluate((el) => {
          const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="thread-row"]')];
          return rows[rows.findIndex((row) => row.hasAttribute("data-cursor")) + 1]!.dataset.threadId;
        });
        await page.keyboard.press("ArrowDown");
        await expect(list).toBeFocused();
        await expect(page.locator('[data-testid="thread-row"][data-cursor]')).toHaveAttribute("data-thread-id", nextId!);
      }
      await expect.poll(async () => (await server.backend.server.invoke("drafts.list", {}, ctx))[0]?.bodyText).toBe(finalText);
      const durable = (await server.backend.server.invoke("drafts.list", {}, ctx))[0]!;
      expect(durable).toEqual({ ...recovered, revision: recovered.revision + (placement === "list focus" ? 0 : 1), bodyText: finalText, bodyHtml: `<div>${finalText}</div>` });
      expect(await server.backend.store.attachments.read(account.id, refs[0]!.assetId, 0)).toBe(bytes.toString("base64"));
      await nodes.dispose();
      // Durability was checked above, before pagehide's best-effort flush can conceal a failed retry.
      await page.reload(); await page.locator("[data-ready]").waitFor();
      await selectThread(page, Number(id), source.thread.subject);
      if (await page.getByTestId("draft-collapsed").isVisible()) await page.getByTestId("draft-collapsed").click();
      await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
      await expect(body).toHaveText(finalText);
      await expect(page.getByTestId("compose-subject")).toHaveValue(durable.subject);
      for (const field of ["to", "cc", "bcc"] as const) {
        expect(await chipsOf(page, `compose-${field}`).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.email))).toEqual(durable[field].map((a) => a.email));
      }
      const reopened = await local(page);
      expect(reopened).toMatchObject({ id: durable.id, generation: durable.generation, context: { threadId: baseline.threadId, source: baseline.inReplyToMessageId, accountId: baseline.accountId, mode: "reply" }, attachments: refs });
      expect(await server.backend.server.invoke("drafts.list", {}, ctx)).toEqual([durable] satisfies Draft[]);
    });
  }
}

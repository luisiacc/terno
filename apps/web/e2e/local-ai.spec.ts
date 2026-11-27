import { E2E_NOW } from "./constants";
import { expect, openRow, selectThread, test, fresh, scenario } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";
import type { Route } from "@playwright/test";

/** Anything off this machine: the demo newsletters' images (answered here, never fetched). */
const remote = (url: URL) => /^https?:$/.test(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost";

test.describe("local mode and AI providers", () => {
  test("AI tab: every provider can be chosen (plan 97: local mode doesn't block the cloud); Ollama lists models and Test shows latency", async ({ app: page }) => {
    const ollama = await startOllamaStub();
    try {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-local-banner")).toHaveCount(0);
      await page.getByTestId("ai-provider").click();
      for (const cloud of ["keys", "compatible"]) await expect(page.getByTestId(`ai-choice-${cloud}`)).not.toHaveAttribute("data-disabled", "");
      await page.getByTestId("ai-choice-ollama").click();
      await expect(page.getByTestId("ai-provider")).toContainText("Ollama");
      await expect(page.getByTestId("ai-endpoint")).toHaveValue("http://127.0.0.1:11434/v1");

      // an endpoint on another machine (a GPU box on the LAN) is the user's to choose, and said where it goes
      // (Codex review R2): the footer no longer says nothing leaves
      await page.getByTestId("ai-endpoint").fill("http://192.168.1.20:11434/v1");
      await expect(page.getByTestId("ai-endpoint-error")).toHaveCount(0);
      await expect(page.getByTestId("ai-privacy")).not.toContainText("Nothing leaves this Mac.");

      await page.getByTestId("ai-endpoint").fill(`${ollama.url}/v1`);
      const options = page.getByTestId("ai-model-option");
      await expect(options).toHaveCount(2);
      await expect(options.first()).toContainText("qwen3:8b");
      await expect(options.first()).toContainText("loaded");
      await expect(options.first()).toContainText("4.9 GB");
      await options.first().click();
      await expect(page.getByTestId("ai-model")).toHaveValue("qwen3:8b");
      await expect(options.first()).toContainText("40k ctx");

      await page.getByTestId("ai-test").click();
      await expect(page.getByTestId("ai-test-result")).toContainText(/Connected · \d+ ms · structured output ✓/);
      await expect(page.getByTestId("ai-privacy")).toContainText("Nothing leaves this Mac.");
      expect(ollama.requests).toContain("POST /v1/chat/completions");

      // the filter builder now uses the local model and says nothing leaves the Mac
      await page.keyboard.press("Escape");
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("ai-privacy-notice")).toHaveText("Nothing leaves this Mac.");
      await page.getByTestId("ai-prompt").fill("archiva los recibos de uber.com");
      await page.getByTestId("ai-generate").click();
      // plan 161: what the rule does, from its fields, not the request said back
      await expect(page.getByTestId("ai-explanation")).toHaveText("Domain is “uber.com” → archive.");
    } finally {
      await ollama.close();
    }
  });

  test("no local-mode wording; no AI pill in the sidebar; a slow test can't touch the next provider", async ({ app: page, server }) => {
    await scenario("no local-mode wording anywhere; Settings → AI says where a cloud AI sends text, and the sidebar shows no AI pill (plan 173, the owner)", async () => {
      const pill = page.getByTestId("cloud-ai-pill");
      await expect(pill).toHaveCount(0);
      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("settings-dialog")).not.toContainText("Local mode");
      await expect(page.getByTestId("local-mode-row")).toHaveCount(0);

      await page.getByTestId("tab-ai").click();
      await page.getByTestId("ai-provider").click();
      await page.getByTestId("ai-choice-keys").click();
      // plan 168: Claude's key and OpenAI's, and no model to choose: Terno picks it
      await expect(page.getByTestId("ai-key-anthropic")).toBeVisible();
      await expect(page.getByTestId("ai-key-openai")).toBeVisible();
      await expect(page.getByTestId("ai-model")).toHaveCount(0);
      await expect(page.getByTestId("ai-routing")).toHaveText("Add either key, or both. Terno picks the model for each feature.");
      // plan 131 (no per-use consent): Settings → AI says that a conversation's text goes there when AI is used on it;
      // before a key, whichever comes first may
      await expect(page.getByTestId("ai-privacy")).toContainText("Claude (Anthropic) and OpenAI receive a conversation’s text when you use an AI feature on it");

      // the key field is never pre-filled; once saved only the last 4 characters are shown
      const openai = page.getByTestId("ai-key-row-openai");
      await openai.getByTestId("ai-key-openai").fill("sk-proj-e2e-secret-key-a1b2");
      await openai.getByRole("button", { name: "Save" }).click();
      await expect(openai.getByTestId("ai-key-saved")).toHaveText(/Saved · …a1b2/);
      await expect(page.locator("body")).not.toContainText("sk-proj-e2e-secret");
      await expect(page.getByTestId("ai-privacy")).toContainText("OpenAI receives a conversation’s text when you use an AI feature on it");
      await expect(page.getByTestId("ai-routing")).toHaveText("Every AI feature runs on OpenAI. Terno picks the model for each.");
      // plan 173 (the owner): the sidebar's footer names no AI, cloud or not; Settings → AI is where it's said
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("open-settings")).toBeVisible();
      await expect(pill).toHaveCount(0);
    });
    await scenario("a slow connection test that finishes after switching provider doesn't touch the new one", async () => {
      await fresh(page);
      let answer!: () => void;
      const ollama = await startOllamaStub({ chatHeld: new Promise<void>((r) => (answer = r)) });
      // the backend's answer to the test, as the page receives it
      let testId: number | undefined;
      let answered!: () => void;
      const arrived = new Promise<void>((r) => (answered = r));
      page.on("websocket", (ws) => {
        ws.on("framesent", ({ payload }) => {
          const m = JSON.parse(String(payload)) as { m?: string; id?: number };
          if (m.m === "ai.test") testId = m.id;
        });
        ws.on("framereceived", ({ payload }) => {
          const m = JSON.parse(String(payload)) as { t?: string; id?: number };
          if (m.t === "res" && testId !== undefined && m.id === testId) answered();
        });
      });
      try {
        await server.backend.server.invoke("settings.update", { localMode: false, ai: { provider: "ollama", baseURL: `${ollama.url}/v1`, model: "qwen3:8b" } }, { clientId: "setup", origin: "dev" });
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await page.getByTestId("open-settings").click();
        await page.getByTestId("tab-ai").click();
        // on this Mac: plan 168, the OpenAI key saved above sends nothing while a local model is chosen
        await expect(page.getByTestId("ai-privacy")).toHaveText("Privacy. Nothing leaves this Mac.");
        await page.getByTestId("ai-test").click();
        await page.getByTestId("ai-provider").click();
        await page.getByTestId("ai-choice-keys").click();
        await expect(page.getByTestId("ai-privacy")).toContainText("OpenAI receives");
        // let the Ollama probe finish, and its answer reach the page
        await expect.poll(() => ollama.requests.filter((r) => r === "POST /v1/chat/completions").length).toBe(1);
        answer();
        await arrived;
        await page.evaluate(() => new Promise((r) => setTimeout(r)));
        await expect(page.getByTestId("ai-test-result")).toHaveCount(0);
        await expect(page.getByTestId("ai-privacy")).toContainText("OpenAI receives");
        await expect(page.getByTestId("ai-privacy")).not.toContainText("Nothing leaves this Mac");
      } finally {
        await ollama.close();
      }
    });
  });

  test("remote images: “Load content”, “Always load”; an HTML mail fits its frame", async ({ app: page, server }) => {
    await scenario("plan 37: in local mode “Load content” loads the message's remote images, for the session", async () => {
      const hits: string[] = [];
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      await page.route(remote, (route) => (hits.push(route.request().url()), route.fulfill({ contentType: "image/png", body: png })));
      await openRow(page, 2);
      const row = page.getByTestId("remote-blocked");
      await expect(row).toHaveText(/Remote content blocked to protect your privacy\./);
      await page.waitForTimeout(300);
      expect(hits).toEqual([]);
      await row.getByRole("button", { name: "Load content" }).click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => hits.length).toBeGreaterThan(0);
      const frame = page.frameLocator("iframe[title^='Message']");
      await expect.poll(() => frame.locator("img[src^='https:']").first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      // coming back to it, it's still loaded (per message, for the session)
      await openRow(page, 0);
      await openRow(page, 2);
      await expect(page.frameLocator("iframe[title^='Message']").locator("h1")).toBeVisible();
      await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
    });
    await scenario("an HTML mail fits its frame with no inner scroll, and the frame follows the content when the pane resizes", async () => {
      await fresh(page);
      await openRow(page, 2);
      const frame = page.locator("iframe[title^='Message']");
      await expect(page.frameLocator("iframe[title^='Message']").locator("h1")).toBeVisible();
      const fits = () =>
        frame.evaluate((f: HTMLIFrameElement) => {
          const root = f.contentDocument!.documentElement;
          // clip (b1c85b77, outer-only preview scroll) is stricter than hidden: not even a script scrolls it
          return { overflow: root.scrollHeight - root.clientHeight, gap: f.clientHeight - Math.ceil(root.getBoundingClientRect().height), scrolls: !["hidden", "clip"].includes(getComputedStyle(root).overflowY) };
        });
      await expect.poll(fits).toEqual({ overflow: 0, gap: 0, scrolls: false });
      const wide = await frame.evaluate((f) => f.clientHeight);
      // narrower: the text wraps into more lines and the frame grows; wider again: it shrinks back
      await page.setViewportSize({ width: 900, height: 900 });
      // (it fits at every moment; growing follows the reflow by a frame)
      await expect.poll(() => frame.evaluate((f) => f.clientHeight)).toBeGreaterThan(wide);
      await expect.poll(fits).toEqual({ overflow: 0, gap: 0, scrolls: false });
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(() => frame.evaluate((f) => f.clientHeight)).toBe(wide);
    });
    await scenario("plan 37: in local mode “Always load remote images” loads them without a click", async () => {
      await fresh(page);
      const hits: string[] = [];
      await page.route(remote, (route) => (hits.push(route.request().url()), route.abort()));
      await page.getByTestId("open-settings").click();
      // plan 294: in Appearance → Messages
      await page.getByTestId("tab-appearance").click();
      const always = page.getByRole("switch", { name: "Always load remote images" });
      await expect(always).toBeEnabled();
      await expect(always).not.toBeChecked();
      await expect(always).toHaveAccessibleDescription(/Blocked by default to prevent tracking/);
      await always.click();
      await expect(always).toBeChecked();
      await page.keyboard.press("Escape");
      await openRow(page, 2);
      await expect(page.frameLocator("iframe[title^='Message']").locator("h1")).toBeVisible();
      await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
      await expect.poll(() => hits.length).toBeGreaterThan(0);
    });
    await scenario("an HTML mail shows whole at once: measured when parsed, not when its pictures arrive, and never a slice first", async () => {
      // its pictures never answer: the frame's load never comes
      const pending: Route[] = [];
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route(remote, (route) => { pending.push(route); });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      // every state the frame is shown in, from its mount (reload: no height remembered)
      await page.evaluate(() => {
        const seen: { visible: boolean; height: number }[] = [];
        (window as unknown as { __frameStates: typeof seen }).__frameStates = seen;
        new MutationObserver(() => {
          const frame = document.querySelector<HTMLIFrameElement>("iframe[title^='Message']");
          if (!frame) return;
          const state = { visible: frame.style.visibility !== "hidden", height: frame.clientHeight };
          const last = seen.at(-1);
          if (last?.visible !== state.visible || last.height !== state.height) seen.push(state);
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      });
      await openRow(page, 2);
      const frame = page.locator("iframe[title^='Message']");
      await expect(frame).toBeVisible();
      await expect.poll(() => pending.length).toBeGreaterThan(0);
      // the content's own height, read apart from the one the frame was given
      const content = await frame.evaluate((f: HTMLIFrameElement) => {
        const d = f.contentDocument!;
        const pad = getComputedStyle(d.body);
        return Math.ceil(d.querySelector("[data-terno-flow]")!.getBoundingClientRect().height + Number.parseFloat(pad.paddingTop) + Number.parseFloat(pad.paddingBottom));
      });
      expect(content).toBeGreaterThan(200);
      const states = await page.evaluate(() => (window as unknown as { __frameStates: { visible: boolean; height: number }[] }).__frameStates);
      expect(states.find((s) => s.visible)?.height).toBe(content);
      // Codex review: a mail too tall for the reader opens whole by "Show full message" while a picture is still on its way
      const store = server.backend.store;
      const account = (await store.accounts.list())[0]!;
      const tall = `<img src="https://stalled.test/hero.png" alt=""><div>${Array.from({ length: 1400 }, (_, i) => `<p style="margin:0;height:20px">Line ${i}</p>`).join("")}</div>`;
      const { touched } = await store.sync.ingest([{ accountId: account.id, providerMsgId: "stalled-1", providerThreadId: "stalled-thread", rfcMessageId: "<stalled-1@e2e.test>", inReplyTo: null, references: [], from: { name: "Yuki", email: "yuki@acme.studio" }, replyTo: [], to: [{ name: "", email: account.email }], cc: [], bcc: [], subject: "Una larga con foto", date: E2E_NOW, snippet: "Line", bodyText: null, bodyHtml: tall, bodyState: "full", listId: null, isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100 }], { applyFilters: false, now: E2E_NOW, classifier: null });
      await selectThread(page, touched[0]!, 'subject:"Una larga con foto"');
      await expect.poll(() => pending.some((route) => route.request().url().includes("stalled.test"))).toBe(true);
      await page.getByRole("button", { name: "Show full message", exact: true }).click();
      await expect(page.locator("[data-full-message-scroller] iframe").first()).toBeVisible();
      await page.keyboard.press("Escape");
      for (const route of pending) await route.abort().catch(() => {});
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  });

});

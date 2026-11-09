import { expect, openRow, test, fresh, scenario } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";

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
      for (const cloud of ["anthropic", "openai", "compatible"]) await expect(page.getByTestId(`ai-choice-${cloud}`)).not.toHaveAttribute("data-disabled", "");
      await page.getByTestId("ai-choice-ollama").click();
      await expect(page.getByTestId("ai-provider")).toContainText("Ollama");
      await expect(page.getByTestId("ai-endpoint")).toHaveValue("http://127.0.0.1:11434/v1");

      // an endpoint on another machine (a GPU box on the LAN) is the user's to choose, and said where it goes
      // (Codex review R2): the pill names it and the footer no longer says nothing leaves
      await page.getByTestId("ai-endpoint").fill("http://192.168.1.20:11434/v1");
      await expect(page.getByTestId("ai-endpoint-error")).toHaveCount(0);
      await expect(page.getByTestId("cloud-ai-pill")).toHaveText("AI: Ollama (cloud)");
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

  test("no local-mode wording; a cloud AI's pill; a slow test can't touch the next provider", async ({ app: page, server }) => {
    await scenario("no local-mode wording anywhere; a cloud AI shows in the sidebar while it's chosen, and its pill opens the AI tab", async () => {
      const pill = page.getByTestId("cloud-ai-pill");
      await expect(pill).toHaveCount(0);
      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("settings-dialog")).not.toContainText("Local mode");
      await expect(page.getByTestId("local-mode-row")).toHaveCount(0);

      await page.getByTestId("tab-ai").click();
      await page.getByTestId("ai-provider").click();
      await page.getByTestId("ai-choice-openai").click();
      await expect(page.getByTestId("ai-key")).toBeVisible();
      await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
      // plan 131 (no per-use consent): Settings → AI says that a conversation's text goes there when AI is used on it
      await expect(page.getByTestId("ai-privacy")).toContainText("OpenAI receives a conversation’s text when you use an AI feature on it");
      // where the mail it's asked about goes, said where the user looks
      await expect(pill).toHaveText("AI: OpenAI (cloud)");

      // the key field is never pre-filled; once saved only the last 4 characters are shown
      await page.getByTestId("ai-key").fill("sk-proj-e2e-secret-key-a1b2");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("ai-key-saved")).toHaveText(/Saved · …a1b2/);
      await expect(page.locator("body")).not.toContainText("sk-proj-e2e-secret");

      // its pill opens the AI tab
      await page.keyboard.press("Escape");
      await pill.click();
      await expect(page.getByTestId("ai-tab")).toBeVisible();
      // a model on this Mac again: nothing to say
      await page.getByTestId("ai-provider").click();
      await page.getByTestId("ai-choice-ollama").click();
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
        // on this Mac, with no host in the title (plan 131's disclosure still names OpenAI: the key saved above sends summaries there)
        await expect(page.getByTestId("ai-privacy")).toContainText("Privacy.");
        await expect(page.getByTestId("ai-privacy")).not.toContainText("api.openai.com");
        await page.getByTestId("ai-test").click();
        await page.getByTestId("ai-provider").click();
        await page.getByTestId("ai-choice-openai").click();
        await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
        // let the Ollama probe finish, and its answer reach the page
        await expect.poll(() => ollama.requests.filter((r) => r === "POST /v1/chat/completions").length).toBe(1);
        answer();
        await arrived;
        await page.evaluate(() => new Promise((r) => setTimeout(r)));
        await expect(page.getByTestId("ai-test-result")).toHaveCount(0);
        await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
        await expect(page.getByTestId("ai-privacy")).not.toContainText("Nothing leaves this Mac");
        await expect(page.getByTestId("cloud-ai-pill")).toHaveText("AI: OpenAI (cloud)");
      } finally {
        await ollama.close();
      }
    });
  });

  test("remote images: “Load content”, “Always load”; an HTML mail fits its frame", async ({ app: page }) => {
    await scenario("plan 37: in local mode “Load content” loads the message's remote images, for the session", async () => {
      await expect(page.getByTestId("cloud-ai-pill")).toHaveCount(0);
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
      const frame = page.frameLocator("iframe[title='Message content']");
      await expect.poll(() => frame.locator("img[src^='https:']").first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      // coming back to it, it's still loaded (per message, for the session)
      await openRow(page, 0);
      await openRow(page, 2);
      await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
      await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
    });
    await scenario("an HTML mail fits its frame with no inner scroll, and the frame follows the content when the pane resizes", async () => {
      await fresh(page);
      await openRow(page, 2);
      const frame = page.locator("iframe[title='Message content']");
      await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
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
      const always = page.getByRole("switch", { name: "Always load remote images" });
      await expect(always).toBeEnabled();
      await expect(always).not.toBeChecked();
      await expect(always).toHaveAccessibleDescription(/Blocked by default to prevent tracking/);
      await always.click();
      await expect(always).toBeChecked();
      await page.keyboard.press("Escape");
      await openRow(page, 2);
      await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
      await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
      await expect.poll(() => hits.length).toBeGreaterThan(0);
    });
  });

});

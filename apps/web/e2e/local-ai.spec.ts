import { expect, openRow, test } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";

/** Anything off this machine: the demo newsletters' images (answered here, never fetched). */
const remote = (url: URL) => /^https?:$/.test(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost";

test.describe("local mode and AI providers", () => {
  test("AI tab: cloud is disabled in local mode; Ollama lists models from the server and Test shows latency", async ({ app: page }) => {
    const ollama = await startOllamaStub();
    try {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-local-banner")).toContainText("Local mode: AI can only use models on this Mac.");
      await page.getByTestId("ai-provider").click();
      for (const cloud of ["anthropic", "openai", "compatible"]) await expect(page.getByTestId(`ai-choice-${cloud}`)).toHaveAttribute("data-disabled", "");
      await expect(page.getByText("In the cloud · turn off local mode to use it")).toBeVisible();
      await page.getByTestId("ai-choice-ollama").click();
      await expect(page.getByTestId("ai-provider")).toContainText("Ollama");
      await expect(page.getByTestId("ai-endpoint")).toHaveValue("http://127.0.0.1:11434/v1");

      // a LAN endpoint is rejected inline in local mode
      await page.getByTestId("ai-endpoint").fill("http://192.168.1.20:11434/v1");
      await expect(page.getByTestId("ai-endpoint-error")).toContainText("must be on this Mac");

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
      await expect(page.getByTestId("ai-explanation")).toContainText("Archiva los recibos de uber.com.");
    } finally {
      await ollama.close();
    }
  });

  test("Local pill opens General; turning local mode off asks first, then cloud AI shows in the pill", async ({ app: page }) => {
    const pill = page.getByTestId("local-pill");
    await expect(pill).toHaveText("Local");
    await pill.click();
    const row = page.getByTestId("local-mode-row");
    await expect(row).toBeVisible();
    // it is the first row of General
    await expect(page.locator("[data-testid=settings-dialog] [role=tabpanel] section > div > :first-child").first()).toHaveAttribute("data-testid", "local-mode-row");
    const toggle = page.getByRole("switch", { name: "Local mode" });
    await expect(toggle).toHaveAccessibleDescription(/Nothing leaves this Mac except mail with your servers and the remote images you load/);
    await expect(toggle).toBeChecked();

    await toggle.click();
    const confirm = page.getByTestId("local-mode-confirm");
    await expect(confirm).toContainText("use cloud AI");
    // plan 35: remote images aren't local mode's to give
    await expect(confirm).not.toContainText("remote images");
    await confirm.getByRole("button", { name: "Keep on" }).click();
    await expect(toggle).toBeChecked();

    await toggle.click();
    await page.getByTestId("local-mode-confirm-off").click();
    await expect(toggle).not.toBeChecked();
    await expect(pill).toHaveCount(0); // the demo model is local: nothing to warn about

    await page.getByTestId("tab-ai").click();
    await page.getByTestId("ai-provider").click();
    await page.getByTestId("ai-choice-openai").click();
    await expect(page.getByTestId("ai-key")).toBeVisible();
    await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
    await expect(page.getByTestId("ai-privacy")).toContainText("Never the content of your messages");
    await expect(pill).toHaveText("AI: OpenAI (cloud)");

    // the key field is never pre-filled; once saved only the last 4 characters are shown
    await page.getByTestId("ai-key").fill("sk-proj-e2e-secret-key-a1b2");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("ai-key-saved")).toHaveText(/Saved · …a1b2/);
    await expect(page.locator("body")).not.toContainText("sk-proj-e2e-secret");

    // back to local mode: the cloud provider is kept but paused
    await page.getByTestId("tab-general").click();
    await page.getByTestId("local-mode-switch").click();
    await expect(pill).toHaveText("Local");
    await page.getByTestId("tab-ai").click();
    await expect(page.getByTestId("ai-local-banner")).toContainText("OpenAI is paused");
  });

  test("a slow connection test that finishes after switching provider doesn't touch the new one", async ({ app: page, server }) => {
    const ollama = await startOllamaStub({ chatDelayMs: 1500 });
    try {
      await server.backend.server.invoke("settings.update", { localMode: false, ai: { provider: "ollama", baseURL: `${ollama.url}/v1`, model: "qwen3:8b" } }, { clientId: "setup", origin: "dev" });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-privacy")).toContainText("Nothing leaves this Mac.");
      await page.getByTestId("ai-test").click();
      await page.getByTestId("ai-provider").click();
      await page.getByTestId("ai-choice-openai").click();
      await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
      // let the Ollama probe finish
      await expect.poll(() => ollama.requests.filter((r) => r === "POST /v1/chat/completions").length).toBe(1);
      await page.waitForTimeout(1800);
      await expect(page.getByTestId("ai-test-result")).toHaveCount(0);
      await expect(page.getByTestId("ai-privacy")).toContainText("api.openai.com");
      await expect(page.getByTestId("ai-privacy")).not.toContainText("Nothing leaves this Mac");
      await expect(page.getByTestId("local-pill")).toHaveText("AI: OpenAI (cloud)");
    } finally {
      await ollama.close();
    }
  });

  test("plan 35: in local mode “Load content” loads the message's remote images, for the session", async ({ app: page }) => {
    await expect(page.getByTestId("local-pill")).toHaveText("Local");
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

  test("plan 35: in local mode “Always load remote images” loads them without a click", async ({ app: page }) => {
    const hits: string[] = [];
    await page.route(remote, (route) => (hits.push(route.request().url()), route.abort()));
    await page.getByTestId("open-settings").click();
    const always = page.getByRole("switch", { name: "Always load remote images" });
    await expect(always).toBeEnabled();
    await expect(always).not.toBeChecked();
    await expect(always).toHaveAccessibleDescription(/Blocked by default to prevent tracking/);
    await always.click();
    await expect(always).toBeChecked();
    await expect(page.getByRole("switch", { name: "Local mode" })).toBeChecked();
    await page.keyboard.press("Escape");
    await openRow(page, 2);
    await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
    await expect(page.getByTestId("remote-blocked")).toHaveCount(0);
    await expect.poll(() => hits.length).toBeGreaterThan(0);
  });

  test("an HTML mail fits its frame with no inner scroll, and the frame follows the content when the pane resizes", async ({ app: page }) => {
    await openRow(page, 2);
    const frame = page.locator("iframe[title='Message content']");
    await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
    const fits = () =>
      frame.evaluate((f: HTMLIFrameElement) => {
        const root = f.contentDocument!.documentElement;
        return { overflow: root.scrollHeight - root.clientHeight, gap: f.clientHeight - Math.ceil(root.getBoundingClientRect().height), scrolls: getComputedStyle(root).overflowY !== "hidden" };
      });
    await expect.poll(fits).toEqual({ overflow: 0, gap: 0, scrolls: false });
    const wide = await frame.evaluate((f) => f.clientHeight);
    // narrower: the text wraps into more lines and the frame grows; wider again: it shrinks back
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(fits).toEqual({ overflow: 0, gap: 0, scrolls: false });
    expect(await frame.evaluate((f) => f.clientHeight)).toBeGreaterThan(wide);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => frame.evaluate((f) => f.clientHeight)).toBe(wide);
  });
});

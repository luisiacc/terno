import { expect, openRow, test } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";

test.describe("local mode and AI providers", () => {
  test("AI tab: cloud is disabled in local mode; Ollama lists models from the server and Test shows latency", async ({ app: page }) => {
    const ollama = await startOllamaStub();
    try {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-local-banner")).toContainText("Modo local: la IA solo puede usar modelos de este Mac.");
      await page.getByTestId("ai-provider").click();
      for (const cloud of ["anthropic", "openai", "compatible"]) await expect(page.getByTestId(`ai-choice-${cloud}`)).toHaveAttribute("data-disabled", "");
      await expect(page.getByText("En la nube · desactiva el modo local para usarla")).toBeVisible();
      await page.getByTestId("ai-choice-ollama").click();
      await expect(page.getByTestId("ai-provider")).toContainText("Ollama");
      await expect(page.getByTestId("ai-endpoint")).toHaveValue("http://127.0.0.1:11434/v1");

      // a LAN endpoint is rejected inline in local mode
      await page.getByTestId("ai-endpoint").fill("http://192.168.1.20:11434/v1");
      await expect(page.getByTestId("ai-endpoint-error")).toContainText("debe estar en este Mac");

      await page.getByTestId("ai-endpoint").fill(`${ollama.url}/v1`);
      const options = page.getByTestId("ai-model-option");
      await expect(options).toHaveCount(2);
      await expect(options.first()).toContainText("qwen3:8b");
      await expect(options.first()).toContainText("cargado");
      await expect(options.first()).toContainText("4.9 GB");
      await options.first().click();
      await expect(page.getByTestId("ai-model")).toHaveValue("qwen3:8b");
      await expect(options.first()).toContainText("40k ctx");

      await page.getByTestId("ai-test").click();
      await expect(page.getByTestId("ai-test-result")).toContainText(/Conectado · \d+ ms · salida estructurada ✓/);
      await expect(page.getByTestId("ai-privacy")).toContainText("Nada sale de este Mac.");
      expect(ollama.requests).toContain("POST /v1/chat/completions");

      // the filter builder now uses the local model and says nothing leaves the Mac
      await page.keyboard.press("Escape");
      await page.getByTestId("open-filters").click();
      await expect(page.getByTestId("ai-privacy-notice")).toHaveText("Nada sale de este Mac.");
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
    await expect(page.locator("[data-testid=settings-dialog] [role=tabpanel] > div").first()).toHaveAttribute("data-testid", "local-mode-row");
    const toggle = page.getByTestId("local-mode-switch");
    await expect(toggle).toBeChecked();

    await toggle.click();
    const confirm = page.getByTestId("local-mode-confirm");
    await expect(confirm).toContainText("usar IA en la nube");
    await expect(confirm).toContainText("cargar imágenes remotas");
    await confirm.getByRole("button", { name: "Mantener activado" }).click();
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
    await expect(page.getByTestId("ai-privacy")).toContainText("Nunca el contenido de tus mensajes");
    await expect(pill).toHaveText("IA: OpenAI (nube)");

    // the key field is never pre-filled; once saved only the last 4 characters are shown
    await page.getByTestId("ai-key").fill("sk-proj-e2e-secret-key-a1b2");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByTestId("ai-key-saved")).toHaveText(/Guardada · …a1b2/);
    await expect(page.locator("body")).not.toContainText("sk-proj-e2e-secret");

    // back to local mode: the cloud provider is kept but paused
    await page.getByTestId("tab-general").click();
    await page.getByTestId("local-mode-switch").click();
    await expect(pill).toHaveText("Local");
    await page.getByTestId("tab-ai").click();
    await expect(page.getByTestId("ai-local-banner")).toContainText("OpenAI queda en pausa");
  });

  test("local mode blocks remote images in mail with no way to load them", async ({ app: page }) => {
    await openRow(page, 2);
    await expect(page.getByTestId("remote-blocked")).toContainText("bloqueado por el modo local");
    await expect(page.getByRole("button", { name: "Cargar imágenes" })).toHaveCount(0);
  });
});

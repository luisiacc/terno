import { expect, test } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";
import type { Page } from "@playwright/test";

async function addImap(page: Page, email: string) {
  await page.getByTestId("imap-email").fill(email);
  await page.getByTestId("imap-password").fill("app-password");
  await page.getByTestId("imap-submit").click();
  await expect(page.getByTestId("add-account-dialog")).toHaveCount(0);
}

test.describe("owner identity", () => {
  test.use({ backendOptions: { ownerClaims: true } });

  test("the first connected mailbox becomes the Única account, and stays it after that mailbox is removed", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-card")).toHaveText(/Tu cuenta Única será el primer correo que conectes/);
    await page.getByRole("button", { name: "Añadir cuenta" }).click();
    await expect(page.getByTestId("owner-first-copy")).toContainText("será tu cuenta Única");
    await addImap(page, "luis@fastmail.com");

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    const card = page.getByTestId("owner-card");
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    await expect(card).toContainText("Se usa para iniciar sesión y para la facturación.");
    await expect(card).toContainText(/Verificada con IMAP · 22 oct 2026/);

    // a second mailbox doesn't replace it, and the add dialog no longer promises it
    await page.getByRole("button", { name: "Añadir cuenta" }).click();
    await expect(page.getByTestId("owner-first-copy")).toHaveCount(0);
    await addImap(page, "work@acme.studio");

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    const prompts: string[] = [];
    page.on("dialog", (d) => (prompts.push(d.message()), void d.accept()));
    await page.getByRole("button", { name: "Quitar luis@fastmail.com" }).click();
    await expect(page.getByRole("button", { name: "Quitar luis@fastmail.com" })).toHaveCount(0);
    expect(prompts[0]).toContain("Seguirá siendo tu cuenta Única; cámbiala en Cambiar…");
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    await expect(card).toContainText("su buzón ya no está conectado");

    // change it to the other mailbox: the password must be typed again
    await page.getByTestId("change-owner-open").click();
    await page.getByTestId("change-owner-account").click();
    await page.getByRole("option", { name: "work@acme.studio" }).click();
    await expect(page.getByTestId("change-owner-account")).toContainText("work@acme.studio");
    await expect(page.getByTestId("change-owner-submit")).toBeDisabled();
    await page.getByTestId("change-owner-password").fill("app-password");
    await page.getByTestId("change-owner-submit").click();
    await expect(page.getByTestId("owner-email")).toHaveText("work@acme.studio");
  });
});

test.describe("first run", () => {
  test.use({ backendOptions: { empty: true, ownerClaims: true } });

  test("fresh install: choose Local (with the Ollama model we found), then add the first account", async ({ app: page, server }) => {
    const ollama = await startOllamaStub();
    try {
      // where this Mac's Ollama listens (the default port may be taken on the machine running the tests)
      await server.backend.server.invoke("settings.update", { ai: { provider: "ollama", baseURL: `${ollama.url}/v1` } }, { clientId: "setup", origin: "dev" });
      await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, { clientId: "setup", origin: "dev" });
      await page.reload();
      const dialog = page.getByTestId("first-run");
      await expect(dialog).toContainText("Paso 1 de 2");
      await expect(page.getByTestId("first-run-local")).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("first-run-found")).toHaveText("Encontramos Ollama con qwen3:8b");
      await page.getByTestId("first-run-next").click();
      await expect(dialog).toContainText("Paso 2 de 2");
      await expect(dialog).toContainText("El primer correo que conectes será tu cuenta Única");
      await page.getByTestId("first-run-add-account").click();
      await expect(page.getByTestId("owner-first-copy")).toBeVisible();
      await addImap(page, "ana@icloud.com");

      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("local-mode-switch")).toBeChecked();
      await page.getByTestId("tab-ai").click();
      await expect(page.getByTestId("ai-provider")).toContainText("Ollama");
      await expect(page.getByTestId("ai-model")).toHaveValue("qwen3:8b");
      await page.getByTestId("tab-accounts").click();
      await expect(page.getByTestId("owner-email")).toHaveText("ana@icloud.com");

      // finished: it doesn't come back
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.getByTestId("first-run")).toHaveCount(0);
    } finally {
      await ollama.close();
    }
  });
});

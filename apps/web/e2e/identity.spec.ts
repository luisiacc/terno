import { expect, isolateLocalDiscovery, test } from "./fixtures";
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

  test("the first connected mailbox becomes the Terno account, and stays it after that mailbox is removed", async ({ app: page, server }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-card")).toHaveText(/Your Terno account will be the first email address you connect/);
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("owner-first-copy")).toContainText("becomes your Terno account");
    await addImap(page, "luis@fastmail.com");

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    const card = page.getByTestId("owner-card");
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    await expect(card).toContainText("Used to sign in and for billing.");
    await expect(card).toContainText(/Verified with IMAP · Oct 22, 2026/);

    // a second mailbox doesn't replace it, and the add dialog no longer promises it
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByTestId("owner-first-copy")).toHaveCount(0);
    await addImap(page, "work@acme.studio");

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    const luis = page.locator("[data-testid=settings-account]").filter({ hasText: "luis@fastmail.com" });
    await luis.getByTestId("account-toggle").click();
    await luis.getByTestId("account-remove").click();
    const confirm = page.getByTestId("account-remove-dialog");
    await expect(confirm).toContainText("Remove luis@fastmail.com?");
    await expect(confirm).toContainText("It stays your Terno account.");
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(luis).toHaveCount(0);
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    await expect(card).toContainText("its mailbox is no longer connected");

    // change it to the other mailbox: the password must be typed again
    await page.getByTestId("change-owner-open").click();
    // a password typed for one mailbox is cleared when another is picked (it would go to that server)
    const pick = async (name: string | RegExp) => {
      await page.getByTestId("change-owner-account").click();
      await page.getByRole("option", { name }).first().click();
    };
    await pick("work@acme.studio");
    await page.getByTestId("change-owner-password").fill("password-typed-for-work");
    await pick(/^(?!work@acme\.studio).*@/);
    await page.getByTestId("change-owner-account").click();
    await page.getByRole("option", { name: "work@acme.studio" }).click();
    await expect(page.getByTestId("change-owner-account")).toContainText("work@acme.studio");
    await expect(page.getByTestId("change-owner-password")).toHaveValue("");
    await expect(page.getByTestId("change-owner-submit")).toBeDisabled();

    // while verifying, the target and password are locked
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const options = server.backend.options as { providers: typeof server.backend.options.providers };
    options.providers = { ...options.providers, verifyImap: () => gate };
    await page.getByTestId("change-owner-password").fill("app-password");
    await page.getByTestId("change-owner-submit").click();
    await expect(page.getByTestId("change-owner-account")).toBeDisabled();
    await expect(page.getByTestId("change-owner-password")).toBeDisabled();
    release();
    await expect(page.getByTestId("owner-email")).toHaveText("work@acme.studio");
  });
});

test.describe("first run", () => {
  test.use({ backendOptions: { empty: true, ownerClaims: true } });

  test("fresh install: choose Local (with the Ollama model we found), then add the first account", async ({ app: page, server }) => {
    const ollama = await startOllamaStub();
    try {
      await isolateLocalDiscovery(server, ollama.url);
      await page.reload();
      const dialog = page.getByTestId("first-run");
      await expect(dialog).toContainText("Step 1 of 2");
      await expect(page.getByTestId("first-run-local")).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("first-run-found")).toHaveText("Found Ollama with qwen3:8b");
      await page.getByTestId("first-run-next").click();
      await expect(dialog).toContainText("Step 2 of 2");
      await expect(dialog).toContainText("The first email address you connect becomes your Terno account");
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

import { msg } from "@terno/store/conformance";
import { axeBothModes, expect, selectThread, stabilize, test } from "./fixtures";

test("reader attachment controls include all visible labels and localized download purpose", async ({ app: page, server }) => {
  const [account] = await server.backend.store.accounts.list();
  const { touched } = await server.backend.store.sync.ingest([msg({ accountId: account!.id, providerMsgId: "attachment-controls", subject: "Attachment controls fixture", attachments: [
    { filename: "résumé.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) },
    { filename: "empty.txt", mime: "text/plain", size: 0, bytes: new Uint8Array() },
    { filename: "unavailable.pdf", mime: "application/pdf", size: 1024 },
  ] })], { applyFilters: false, now: Date.now(), classifier: null });
  await page.reload(); await selectThread(page, touched[0]!, 'subject:"Attachment controls fixture"');
  const cached = page.getByTestId("attachment").getByRole("button", { name: /Download résumé.bin/ });
  await expect(cached).toBeVisible();
  await stabilize(page);
  await axeBothModes(page, "[data-testid=attachment]");
  await expect(cached).toHaveAccessibleName("Download résumé.bin 3 B");
  await expect(cached).toHaveAccessibleDescription("application/octet-stream");
  await expect(page.getByTestId("attachment").getByRole("button", { name: /Download empty.txt/ })).toHaveAccessibleName("Download empty.txt 0 B");
  await expect(page.getByTestId("attachment").getByRole("button", { name: /Download unavailable.pdf/ })).toHaveAccessibleName("Download unavailable.pdf 1 KB · Unavailable offline");
  await page.keyboard.press("Meta+Comma");
  await page.getByTestId("language-select").click(); await page.getByTestId("language-es").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attachment").getByRole("button", { name: /Descargar résumé.bin/ })).toHaveAccessibleName("Descargar résumé.bin 3 B");
});

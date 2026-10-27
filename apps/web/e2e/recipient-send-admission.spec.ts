import { contract } from "@terno/core/rpc";
import { parseRaw } from "@terno/mail";
import AxeBuilder from "@axe-core/playwright";
import { addRecipients, chipsOf, expect, openRow, recipientEmails, stabilize, test } from "./fixtures";

test.use({ backendOptions: { smtpCapture: true } });

for (const placement of ["new", "inline"] as const) {
  test(`${placement} recipients stay read-only through Send refusal and retry @design`, async ({ app: page, server }, testInfo) => {
    if (placement === "new") {
      await page.keyboard.press("c");
      await addRecipients(page, "compose-to", "initial@example.test");
      await page.getByTestId("compose-subject").fill("Recipient admission fixture");
    } else {
      await openRow(page, 0);
      await page.getByTestId("quick-reply").click();
    }
    await page.getByTestId("compose-body").fill("Work retained after refusal");
    const originalRecipients = await recipientEmails(page, "compose-to");
    expect(originalRecipients).toHaveLength(1);
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...args: unknown[]) => unknown> }).handlers;
    const send = handlers["compose.send"]!;
    const requests: Array<ReturnType<typeof contract["compose.send"]["params"]["parse"]>> = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    handlers["compose.send"] = async (...args: unknown[]) => {
      requests.push(contract["compose.send"].params.parse(args[0]));
      if (requests.length === 1) { await gate; throw new Error("Synthetic send refusal"); }
      return send(...args);
    };
    try {
      await page.getByTestId("compose-send").click();
      await expect.poll(() => requests.length).toBe(1);
      await expect(page.getByTestId("compose-send")).toBeDisabled();
      await page.getByTestId("compose-to").focus();
      await page.keyboard.press("Backspace");
      await expect(chipsOf(page, "compose-to").first()).toBeFocused();
      await page.keyboard.press("Backspace");
      expect(await recipientEmails(page, "compose-to")).toEqual(originalRecipients);
      await page.getByTestId("compose-to").focus();
      await page.keyboard.type("ignored@example.test");
      await expect(page.getByTestId("compose-to")).toHaveValue("");
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme }); await stabilize(page);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`pending-${theme}.png`) });
      }
      release();
      await expect(page.getByTestId("compose-send")).toBeEnabled();
      expect(await recipientEmails(page, "compose-to")).toEqual(originalRecipients);
      await expect(page.getByTestId("compose-body")).toHaveText("Work retained after refusal");
      await page.getByTestId("compose-to").focus();
      await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
      await expect(chipsOf(page, "compose-to")).toHaveCount(0);
      await addRecipients(page, "compose-to", "replacement@example.test");
      expect(await recipientEmails(page, "compose-to")).toEqual(["replacement@example.test"]);
      await page.getByTestId("compose-send").click();
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[0]!.to.map((a) => a.email)).toEqual(originalRecipients);
      expect(requests[1]!.to.map((a) => a.email)).toEqual(["replacement@example.test"]);
      await expect.poll(() => server.smtp.length).toBe(1);
      expect((await parseRaw(server.smtp[0]!.raw)).to.map((a) => a.email)).toEqual(["replacement@example.test"]);
      await expect(page.getByTestId("composer")).toHaveCount(0);
    } finally { release(); handlers["compose.send"] = send; }
  });
}

import { addRecipients, chipsOf, expect, test } from "./fixtures";

test("recipient elements survive native composition, caret changes and native Undo", async ({ app: page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  const input = page.getByTestId("compose-to");
  await expect(input).toBeFocused();
  await addRecipients(page, "compose-to", "Ana <ana@example.com>, Bob <bob@example.com>");
  await input.evaluate((el) => {
    (window as unknown as { chipNodes: Element[] }).chipNodes = [...el.parentElement!.querySelectorAll("[data-chip-key]")];
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
    await expect(input).toHaveValue("にほん");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
    await expect(chipsOf(page, "compose-to")).toHaveCount(2);
    await cdp.send("Input.insertText", { text: "日本" });
    await expect(input).toHaveValue("日本");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 2]);
    expect(await page.evaluate(() => {
      const nodes = (window as unknown as { chipNodes: Element[] }).chipNodes;
      return nodes.every((node, i) => node === document.querySelectorAll('[data-recipient-field="compose-to"] [data-chip-key]')[i]);
    })).toBe(true);
    await page.keyboard.press("Enter");
    await expect(chipsOf(page, "compose-to")).toHaveCount(3);
    await input.evaluate((el) => el.dispatchEvent(new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true })));
    await expect(chipsOf(page, "compose-to")).toHaveCount(2);
    await expect(input).toHaveValue("日本");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([2, 2]);
  } finally { await cdp.detach(); }
});

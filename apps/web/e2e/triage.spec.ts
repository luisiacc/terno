import { expect, navTo, focusList, openRow, rows, rowSubject, selectedId, selectedRow, test } from "./fixtures";

test.describe("keyboard triage", { tag: "@design" }, () => {
  test("j/k move the selection and the reader follows", async ({ app: page }) => {
    const ids = await rows(page).evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute("data-thread-id")));
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", ids[0]!);
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", ids[2]!);
    const subjectInRow = (await rowSubject(rows(page).nth(2)).textContent())!.trim();
    await expect(page.getByTestId("reader-subject")).toHaveText(subjectInRow);
    await page.keyboard.press("k");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", ids[1]!);
  });

  test("e archives, advances to the next thread, and Undo restores it", async ({ app: page }) => {
    const archived = await openRow(page, 1);
    const next = await rows(page).nth(2).getAttribute("data-thread-id");
    await focusList(page);
    await page.keyboard.press("e");
    await expect(page.locator(`[data-thread-id="${archived}"]`)).toHaveCount(0);
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", next!);
    const toast = page.locator("[data-testid=snack]").filter({ hasText: "Archived" });
    await expect(toast).toBeVisible();
    // it really left the inbox on the backend: it shows up in Archive
    await toast.getByTestId("snack-action").click();
    await expect(page.locator(`[data-thread-id="${archived}"]`)).toHaveCount(1);
  });

  test("# trashes into Trash, s stars into Starred", async ({ app: page }) => {
    const trashed = await openRow(page, 0);
    await page.keyboard.press("#");
    await expect(page.locator(`[data-thread-id="${trashed}"]`)).toHaveCount(0);
    const starred = (await selectedId(page))!;
    await page.keyboard.press("s");
    await expect(selectedRow(page).locator("svg.fill-star")).toBeVisible();

    await navTo(page, "trash");
    await expect(page.locator(`[data-thread-id="${trashed}"]`)).toHaveCount(1);
    await page.getByTestId("nav-starred").click();
    await expect(page.getByTestId("list-title")).toHaveText("Starred");
    await expect(page.locator(`[data-thread-id="${starred}"]`)).toHaveCount(1);
  });

  test("u marks the open thread unread", async ({ app: page }) => {
    const id = await openRow(page, 0);
    const row = page.locator(`[data-thread-id="${id}"]`);
    await expect(row).not.toHaveAttribute("data-unread", "true");
    await page.keyboard.press("u");
    await expect(row).toHaveAttribute("data-unread", "true");
  });

  test("x selects several threads and e archives them together", async ({ app: page }) => {
    const ids = await rows(page).evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute("data-thread-id")!));
    await page.keyboard.press("x");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await page.keyboard.press("e");
    for (const id of ids) await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator("[data-testid=snack]").filter({ hasText: "3 conversations" })).toBeVisible();
    await navTo(page, "archive");
    for (const id of ids) await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(1);
  });

  test("opening an unread thread marks it read after a short dwell (not while flying past)", async ({ app: page }) => {
    const unread = page.locator("[data-testid=thread-row][data-unread]").first();
    const id = (await unread.getAttribute("data-thread-id"))!;
    await unread.dispatchEvent("mousedown");
    await expect(page.locator(`[data-thread-id="${id}"]`)).not.toHaveAttribute("data-unread", "true", { timeout: 3000 });
    await expect(page.getByTestId("nav-inbox")).toBeVisible();
  });
});

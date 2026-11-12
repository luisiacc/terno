/**
 * Plan 178: dragging mail onto Starred, Archive, Spam and Trash does that place's action, exactly as its button: the
 * rows leave (or, starred, stay), the backend has it, z takes it back; an account's own place (its row, a favorite of it)
 * takes its own mail and refuses another account's, saying why.
 */
import type { Locator, Page } from "@playwright/test";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, freshStart, rows, scenario, selectRows, test } from "./fixtures";

test.use({ reducedMotion: "no-preference" });

type Flags = { in_inbox: number; in_trash: number; in_spam: number; is_starred: number };
const flags = (server: DevServer, id: number | string) => sqlDb(server.backend.store).get<Flags>("SELECT in_inbox, in_trash, in_spam, is_starred FROM threads WHERE id = ?", Number(id))!;
const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
const row = (page: Page, id: number | string) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const ids = (page: Page, n: number) => rows(page).evaluateAll((els, n) => els.slice(0, n).map((e) => e.getAttribute("data-thread-id")!), n);

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** The sidebar at rest: More's slide (motion is on here) over, so a target's box is where it will stay. */
const sidebarStill = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.getAnimations().filter((x) => x.playState === "running" && ((x.effect as KeyframeEffect | null)?.target as Element | null)?.closest?.("#app-sidebar")).length)).toBe(0);
/** Presses on a row and moves (in steps, like a hand) onto a target, without releasing. */
async function dragTo(page: Page, from: Locator, target: Locator) {
  await sidebarStill(page);
  const a = await center(from);
  const b = await center(target);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 6, a.y + 2, { steps: 2 });
  await page.mouse.move(b.x, b.y, { steps: 12 });
}
/** Archive, Spam and Trash sit behind More (plan 21) */
async function openMore(page: Page) {
  const more = page.getByTestId("nav-more");
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await expect(page.getByTestId("nav-trash")).toBeVisible();
}

test.describe("dragging mail onto a place does its action", () => {
  test("Archive, Starred, Trash and Spam", async ({ app: page, server }) => {
    await openMore(page);
    await scenario("two checked rows onto Archive: both leave, archived, and z brings both back", async () => {
      const two = await ids(page, 2);
      await selectRows(page, two);
      await dragTo(page, row(page, two[1]!), page.getByTestId("nav-archive"));
      await expect(page.getByTestId("drag-ghost-count")).toHaveText("2");
      await expect(page.getByTestId("nav-archive")).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      for (const id of two) await expect(row(page, id)).toHaveCount(0);
      await expect(page.getByTestId("snack-message").first()).toContainText("Archived");
      for (const id of two) await expect.poll(() => flags(server, id).in_inbox).toBe(0);
      await page.keyboard.press("z");
      for (const id of two) await expect(row(page, id)).toBeVisible();
      for (const id of two) await expect.poll(() => flags(server, id).in_inbox).toBe(1);
    });
    await scenario("onto Starred: starred where it is; dragged again, the ✓", async () => {
      await freshStart(page);
      await openMore(page);
      const id = (await ids(page, 20)).find((x) => flags(server, x).is_starred === 0)!;
      const starred = page.getByTestId("nav-starred");
      await dragTo(page, row(page, id), starred);
      await expect(starred).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect.poll(() => flags(server, id).is_starred).toBe(1);
      await expect(row(page, id)).toBeVisible();
      await dragTo(page, row(page, id), starred);
      await expect(starred).toHaveAttribute("data-drop-state", "already");
      await page.mouse.up();
      await expect(starred).not.toHaveAttribute("data-drop-state");
    });
    await scenario("onto Trash and onto Spam: each takes its row", async () => {
      await freshStart(page);
      await openMore(page);
      const [toTrash, toSpam] = await ids(page, 2);
      await dragTo(page, row(page, toTrash!), page.getByTestId("nav-trash"));
      await page.mouse.up();
      await expect(row(page, toTrash!)).toHaveCount(0);
      await expect.poll(() => flags(server, toTrash!).in_trash).toBe(1);
      await dragTo(page, row(page, toSpam!), page.getByTestId("nav-spam"));
      await page.mouse.up();
      await expect(row(page, toSpam!)).toHaveCount(0);
      await expect.poll(() => flags(server, toSpam!).in_spam).toBe(1);
    });
  });

  test("an account's places, and a favorite of one, take that account's mail only", async ({ app: page, server }) => {
    const freelance = accountOf(server, "Freelance");
    await server.backend.server.invoke("folders.favorite", { accountId: freelance, folder: null, view: "trash", on: true }, { clientId: "setup", origin: "dev" });
    // its places open, the list every account's
    await page.getByTestId(`nav-account-${freelance}`).dblclick();
    await page.getByTestId("nav-inbox").click();
    const trash = page.getByTestId(`nav-folder-${freelance}-trash`);
    await expect(trash).toBeVisible();
    const accountOfThread = (x: string) => sqlDb(server.backend.store).get<{ account_id: number }>("SELECT account_id FROM threads WHERE id = ?", Number(x))!.account_id;
    const onScreen = await ids(page, 40);
    const [mine, alsoMine] = onScreen.filter((x) => accountOfThread(x) === freelance);
    const theirs = onScreen.find((x) => accountOfThread(x) !== freelance)!;
    await scenario("another account's row: refused, said why, nothing changes", async () => {
      await dragTo(page, row(page, theirs), trash);
      await expect(trash).toHaveAttribute("data-drop-state", "refused");
      await page.mouse.up();
      await expect(page.getByTestId("snack").getByText("another account")).toBeVisible();
      await expect(row(page, theirs)).toBeVisible();
      expect(flags(server, theirs).in_trash).toBe(0);
    });
    await scenario("its own row onto its Archive: archived", async () => {
      const archive = page.getByTestId(`nav-folder-${freelance}-archive`);
      await dragTo(page, row(page, mine!), archive);
      await expect(archive).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect(row(page, mine!)).toHaveCount(0);
      await expect.poll(() => flags(server, mine!).in_inbox).toBe(0);
    });
    await scenario("its own row onto the favorite of its Trash: trashed", async () => {
      const favorite = page.getByTestId(`nav-fav-${freelance}-trash`);
      await expect(favorite).toBeVisible();
      await dragTo(page, row(page, alsoMine!), favorite);
      await expect(favorite).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect(row(page, alsoMine!)).toHaveCount(0);
      await expect.poll(() => flags(server, alsoMine!).in_trash).toBe(1);
    });
  });
});

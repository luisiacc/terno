/**
 * Plan 208: Relief's depth, measured in the running app: raised controls carry its rim and lit edge, tracks and fields are
 * sunk, Settings' groups are raised cards, and the switch is the picture's pale track and plain disc. A nested preview of
 * another design draws flat, and macOS (flat) draws exactly the shadows it did before depth was a design value.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, fresh, openRow, scenario, test } from "./fixtures";

// the real components, rendered to markup as controls.spec.ts does (helpers/controls-markup.ts says why)
const ui = new URL("../../../packages/ui/", import.meta.url);
const tsx = createRequire(new URL("package.json", ui)).resolve("tsx/cli");
const markup = execFileSync(process.execPath, [tsx, fileURLToPath(new URL("./helpers/controls-markup.ts", import.meta.url))], { cwd: fileURLToPath(ui), encoding: "utf8" });
const addControls = (page: Page) => page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);

/** The layers of a computed box-shadow that draw something (Tailwind composes empty ones for rings it isn't drawing) */
const layers = (el: Locator) => el.evaluate((node) => {
  const s = getComputedStyle(node).boxShadow;
  return s === "none" ? 0 : s.split(/,(?![^(]*\))/).filter((l) => !/^\s*rgba\(0, 0, 0, 0\) 0px 0px 0px 0px\s*$/.test(l)).length;
});
const shadow = (el: Locator) => el.evaluate((node) => getComputedStyle(node).boxShadow);
const insets = (el: Locator) => el.evaluate((node) => (getComputedStyle(node).boxShadow.match(/inset/g) ?? []).length);

test.describe("Relief (plan 208)", () => {
  test.use({ design: "relief" });

  test("raised, sunk and lit as the pictures are", async ({ app: page }) => {
    await scenario("the real controls: raised pills ringed and lit, tracks and fields sunk, words pressed in", async () => {
      await addControls(page);
      // the outline button: a white ring inside its rim, the lit top edge, a contact shadow and a drop
      const outline = page.getByTestId("state-outline");
      expect(await insets(outline)).toBe(2);
      expect(await layers(outline)).toBeGreaterThanOrEqual(4);
      expect(await outline.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
      expect(await outline.evaluate((el) => getComputedStyle(el).textShadow)).not.toBe("none");
      // the primary: the ink's rim and lift
      expect(await layers(page.getByTestId("primary"))).toBeGreaterThanOrEqual(4);
      // the segmented control: a sunk track, the chosen item raised with its rim in the shadow
      expect(await insets(page.getByTestId("segmented"))).toBe(2);
      expect(await layers(page.getByTestId("segmented-on"))).toBeGreaterThanOrEqual(5);
      // a field is sunk
      expect(await insets(page.getByTestId("group"))).toBeGreaterThanOrEqual(1);
    });
    await scenario("the reader's Reply · Forward: hovered, Reply keeps the group's rim, lit edge and sheen", async () => {
      await fresh(page);
      await openRow(page, 0);
      // the rim and lit edge are an overlay above the items, so a hovered item's fill never covers them (the owner: a
      // hovered Reply lost both), and the item keeps the sheen over its fill, as the outline button does
      const reply = page.getByTestId("action-reply");
      const group = reply.locator("xpath=..");
      expect(await insets(group)).toBe(0);
      expect(await group.evaluate((el) => (getComputedStyle(el, "::after").boxShadow.match(/inset/g) ?? []).length)).toBe(2);
      await reply.hover();
      await expect(reply).toHaveCSS("background-image", /linear-gradient/);
      // …and drawn on screen, in both modes: over the hovered Reply, the line inside the rim is lit above the fill below
      // its words (unfixed, the fill covered the line and the two were one grey)
      await page.addStyleTag({ content: "[data-slot=button-group-item]{transition:none!important}" });
      const box = (await group.boundingBox())!;
      const r = (await reply.boundingBox())!;
      const x = r.x + r.width / 2 - box.x;
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        const png = (await group.screenshot()).toString("base64");
        const [top, low] = await page.evaluate(async ({ png, width, points }) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          const scale = bitmap.width / width;
          return points.map(([px, py]) => ctx.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data.slice(0, 3).reduce((a, b) => a + b, 0) / 3);
        }, { png, width: box.width, points: [[x, 1], [x, box.height - 5]] });
        expect(top - low, `${colorScheme}: the lit edge over the hovered Reply`).toBeGreaterThan(6);
      }
      await page.emulateMedia({ colorScheme: "light" });
    });
    await scenario("Settings: raised cards, the pale switch with its rim and a plain disc, the chosen tab lifted", async () => {
      await fresh(page);
      await page.keyboard.press("Meta+,");
      const dialog = page.getByTestId("settings-dialog");
      const group = dialog.locator(".card-group").first();
      await expect(group).toHaveCSS("border-radius", "18px");
      expect(await group.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await layers(group)).toBeGreaterThanOrEqual(4);
      const off = dialog.locator('[data-slot="switch"][data-unchecked]').first();
      expect(await insets(off)).toBe(2);
      // the chip is the flat designs' only
      expect(await off.locator('[data-slot="switch-thumb"]').evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("0");
      expect(await insets(off.locator('[data-slot="switch-thumb"]'))).toBe(1);
      expect(await layers(off.locator('[data-slot="switch-thumb"]'))).toBeGreaterThanOrEqual(4);
      expect(await layers(dialog.locator('[data-settings-tab][data-active]'))).toBe(3);
      // a nested preview of a flat design draws flat
      await page.getByTestId("tab-appearance").click();
      const lumen = page.getByTestId("design-card-lumen").locator('[data-design="lumen"]');
      expect(await lumen.evaluate((el) => [getComputedStyle(el).getPropertyValue("--depth-well").trim(), getComputedStyle(el).getPropertyValue("--emboss").trim()])).toEqual(["0 0 transparent", "none"]);
    });
    await scenario("a plain select stays plain: the composer's From has no sheen or pressed-in words (Codex code review)", async () => {
      await fresh(page);
      await page.keyboard.press("c");
      const from = page.getByTestId("compose-from");
      await expect(from).toBeVisible();
      expect(await from.evaluate((el) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).textShadow])).toEqual(["none", "none"]);
    });
  });
});

/** A row's sender and subject: their weights and colours, and the colour a token resolves to on the row */
const words = (row: Locator) => row.evaluate((r) => {
  const probe = (v: string) => {
    const i = r.appendChild(document.createElement("i"));
    i.style.color = `var(${v})`;
    const c = getComputedStyle(i).color;
    i.remove();
    return c;
  };
  const style = (id: string) => getComputedStyle(r.querySelector(`[data-testid=${id}]`)!);
  return { from: [style("row-from").fontWeight, style("row-from").color], subject: [style("row-subject").fontWeight, style("row-subject").color], ink: probe("--foreground"), read: probe("--row-read"), selected: probe("--row-selected-foreground") };
});

test.describe("Relief's read and unread rows (plan 208, after relief-r03)", () => {
  test.use({ design: "relief" });

  test("unread is one heavy block in the ink, read is regular in the softer ink, the open row the selection's", async ({ app: page, server }) => {
    const rows = page.getByTestId("thread-row");
    const read = page.locator("[data-testid=thread-row]:not([data-unread]):not([data-opened])").first();
    const id = Number(await read.getAttribute("data-thread-id"));
    await server.backend.server.invoke("threads.act", { threadIds: [id], action: "markUnread" }, { clientId: "setup", origin: "dev" });
    const unread = rows.and(page.locator(`[data-thread-id="${id}"]`));
    await expect(unread).toHaveAttribute("data-unread");
    const u = await words(unread);
    expect([u.from, u.subject]).toEqual([["650", u.ink], ["650", u.ink]]);
    const r = await words(page.locator("[data-testid=thread-row]:not([data-unread]):not([data-opened])").first());
    expect(r.read).not.toBe(r.ink);
    expect([r.from, r.subject]).toEqual([["500", r.read], ["400", r.read]]);
    // the open row, read, in the selection's own ink
    const opened = page.locator("[data-testid=thread-row]:not([data-unread])").nth(1);
    await opened.click();
    await expect(opened).toHaveAttribute("data-opened");
    const o = await words(opened);
    expect([o.from[1], o.subject[1]]).toEqual([o.selected, o.selected]);
  });
});

test.describe("Relief dark (plan 208)", () => {
  test.use({ design: "relief" });

  test("the filled buttons' own colours reach their icons and keys (UI rating relief-r01)", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: "dark" }, { clientId: "setup", origin: "dev" });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    const rows = page.getByTestId("thread-row");
    await rows.nth(1).click({ modifiers: [meta] });
    await rows.nth(2).click({ modifiers: [meta] });
    const archive = page.getByTestId("bar-archive").first();
    await expect(archive).toBeVisible();
    const colors = await archive.evaluate((el) => ({ text: getComputedStyle(el).color, icon: getComputedStyle(el.querySelector("svg")!).color, key: el.querySelector("kbd") ? getComputedStyle(el.querySelector("kbd")!).color : getComputedStyle(el).color }));
    expect(colors.icon).toBe(colors.text);
    expect(colors.key).toBe(colors.text);
  });
});

test.describe("a flat design keeps what it drew (plan 208)", () => {
  test("macOS: the same shadows as before depth was a design value", async ({ app: page }) => {
    await scenario("the real controls", async () => {
      await addControls(page);
      // what Tailwind's shadow-xs draws, for comparison
      const xs = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.className = "shadow-xs";
        const s = getComputedStyle(probe).boxShadow;
        probe.remove();
        return s;
      });
      expect(await shadow(page.getByTestId("state-outline"))).toBe(xs);
      expect(await shadow(page.getByTestId("segmented-on"))).toBe(xs);
      expect(await page.getByTestId("state-outline").evaluate((el) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).textShadow])).toEqual(["none", "none"]);
      expect(await layers(page.getByTestId("primary"))).toBe(2);
      // the track has no shadow worth drawing
      expect(await layers(page.getByTestId("segmented"))).toBe(0);
    });
    await scenario("a read row's words stay in the row's ink (only Relief sets them back)", async () => {
      const r = await words(page.locator("[data-testid=thread-row]:not([data-unread]):not([data-opened])").first());
      expect([r.from[1], r.subject[1]]).toEqual([r.ink, r.ink]);
    });
  });
});

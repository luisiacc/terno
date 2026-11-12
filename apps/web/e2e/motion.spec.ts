/**
 * Motion: nothing runs longer than 100 ms, 0 (or the OS asking for reduced
 * motion) turns every animation off, and list navigation never animates.
 * One exception, by id: the docked snackbar's countdown ring (plan 13) is
 * the snack's lifetime, not decoration; with motion off it steps once a second.
 * The config forces reduced motion for every other spec; these opt out.
 */
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusList, fresh, ingestConversation, rows, scenario, test } from "./fixtures";
import { E2E_NOW } from "./constants";
import { sqlDb } from "../../backend-dev/src/server";

const ctx = { clientId: "setup", origin: "dev" as const };

type Sample = { max: number; finite: number; loops: number; names: string[] };

/** Samples document.getAnimations() every frame: finite ones (with their length) and loops (spinners, pulses, pings). */
async function startSampler(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __anim: { durations: number[]; finite: number; loops: number; names: string[]; stop: boolean } };
    w.__anim = { durations: [], finite: 0, loops: 0, names: [], stop: false };
    const seen = new WeakSet<Animation>();
    const tick = () => {
      for (const a of document.getAnimations()) {
        // and what tracks a scroller (the learned offer over the list) isn't motion: it moves only as the list does
        if (a.id === "pill-countdown" || a.timeline instanceof ScrollTimeline) continue;
        const t = a.effect?.getTiming();
        if (!t) continue;
        const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
        const name = `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?"}@${el?.getAttribute("data-testid") ?? el?.getAttribute("aria-label") ?? el?.getAttribute("class")?.slice(0, 60)}`;
        if (!w.__anim.names.includes(name)) w.__anim.names.push(name);
        if (seen.has(a)) continue;
        seen.add(a);
        if (t.iterations === Infinity) w.__anim.loops++;
        else {
          w.__anim.finite++;
          w.__anim.durations.push(Number(t.duration) + Number(t.delay ?? 0));
        }
      }
      if (!w.__anim.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const sampled = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const w = window as unknown as { __anim: { durations: number[]; finite: number; loops: number; names: string[]; stop: boolean } };
    w.__anim.stop = true;
    return { max: Math.max(0, ...w.__anim.durations), finite: w.__anim.finite, loops: w.__anim.loops, names: w.__anim.names };
  });

/** Plans 195–199: every arrival (and plan 196's seal) asked for, as it starts (one runs ≤ 100 ms: by the time a locator answers it may be over) */
async function recordArrivals(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __arrivals: { id: string | null; testid: string | null; thread: string | null }[] };
    // installed once per page; a new recording clears what the last one saw (wrapping again would count each twice)
    const installed = (w as unknown as { __arrivalsOn?: boolean }).__arrivalsOn;
    w.__arrivals = [];
    if (installed) return;
    (w as unknown as { __arrivalsOn?: boolean }).__arrivalsOn = true;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (typeof options === "object" && (options.id === "arrive" || options.id === "seal")) w.__arrivals.push({ id: options.id, testid: this.getAttribute("data-testid") ?? (this.hasAttribute("data-keep-scroll") ? "list" : this.hasAttribute("data-message-date") ? "message-date" : this.getAttribute("data-slot")), thread: this.getAttribute("data-thread-id") });
      return original.call(this, keyframes, options);
    };
  });
}
const arrivals = (page: Page) => page.evaluate(() => (window as unknown as { __arrivals: { id: string; testid: string | null; thread: string | null }[] }).__arrivals);

/** Holds a backend method until released, so its loading state (spinner, skeleton) stays on screen. */
function hold(server: DevServer, method: string) {
  const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
  const original = handlers[method]!;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  handlers[method] = async (...args: unknown[]) => {
    await gate;
    return original(...args);
  };
  return () => {
    release();
    handlers[method] = original;
  };
}

/** What a change started is running by the frame after it, and the sampler reads every frame. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/**
 * Opens and closes a dialog, a select popup and a menu-like popover, expands a
 * collapsed message, opens an inline reply and collapses it, and shows a toast.
 */
async function exercise(page: Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.getByTestId("settings-dialog").getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await frames(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  // a conversation with earlier (collapsed) messages: one expands, then collapses
  await page.locator("[data-testid=thread-row][data-messages]").first().dispatchEvent("mousedown");
  const collapsed = page.locator("[data-testid=message-toggle][aria-expanded=false]").first();
  if (await collapsed.count()) {
    await collapsed.click();
    await frames(page);
    await page.locator("[data-testid=message-toggle][aria-expanded=true]").first().click();
    await frames(page);
  }
  // the inline reply opens and collapses
  await focusList(page);
  await page.keyboard.press("r");
  await expect(page.getByTestId("compose-body")).toBeFocused();
  await frames(page);
  // (with something in it: an empty one goes on Esc)
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("draft-collapsed")).toBeVisible();
  await frames(page);
  await focusList(page);
  await rows(page).first().dispatchEvent("mousedown");
  await page.keyboard.press("e");
  await expect(page.locator("[data-testid=snack]").first()).toBeVisible();
  await expect(page.getByTestId("countdown-ring")).toBeVisible();
  await frames(page);
}

/** Loading states that loop: the AI filter builder's spinner and the snackbar's count skeleton, held on screen. */
async function exerciseLoading(page: Page, server: DevServer) {
  const releaseAi = hold(server, "filters.generate");
  await page.getByTestId("open-filters").click();
  await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com");
  await page.getByTestId("ai-generate").click();
  await expect(page.getByTestId("ai-generate").locator(".animate-spin")).toBeVisible();
  await frames(page);
  releaseAi();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ai-generate")).toHaveCount(0);

  const releaseCount = hold(server, "categorize.count");
  const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first();
  await row.dispatchEvent("mousedown");
  await focusList(page);
  await page.keyboard.press("l");
  await page.getByTestId(`pick-category-${facturas}`).click();
  await page.getByTestId("snackbar-similar").click();
  await expect(page.getByTestId("snackbar-count-loading").first()).toBeVisible();
  await frames(page);
  releaseCount();
}

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("in a design: nothing runs longer than 100 ms at the default; 0, or the OS asking, turns everything off", { tag: "@variant" }, async ({ app: page, server }) => {
    await scenario("at the default 75 ms nothing runs longer than 100 ms; loading loops run", async () => {
      await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
      await startSampler(page);
      await exercise(page);
      await exerciseLoading(page, server);
      const r = await sampled(page);
      expect(r.finite).toBeGreaterThan(0); // things did animate
      expect(r.loops, r.names.join(",")).toBeGreaterThanOrEqual(2); // the spinner and the skeleton pulse were exercised
      expect(r.max, r.names.join(",")).toBeLessThanOrEqual(100);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion-slow").trim())).toBe("100ms");
    });
    await scenario("0 turns every animation, transition and loop off", async () => {
      await fresh(page);
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await page.getByTestId("motion-0").click();
      await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
      await startSampler(page);
      await exercise(page);
      await exerciseLoading(page, server);
      const r = await sampled(page);
      expect({ finite: r.finite, loops: r.loops }, r.names.join(",")).toEqual({ finite: 0, loops: 0 });
      expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.id !== "pill-countdown" && !(a.timeline instanceof ScrollTimeline)).length)).toBe(0);
      // the snack's lifetime still shows, stepping instead of flowing
      await rows(page).first().dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("e");
      await expect(page.getByTestId("countdown-ring")).toBeVisible();
      const easing = await page.evaluate(() => document.getAnimations().find((a) => a.id === "pill-countdown")?.effect?.getTiming().easing);
      expect(easing).toMatch(/^steps\(/);
    });
    await scenario("the OS's reduced motion overrides the setting: nothing animates", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await server.backend.server.invoke("settings.update", { motionMs: 100 }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
      await startSampler(page);
      await exercise(page);
      await exerciseLoading(page, server);
      const r = await sampled(page);
      expect({ finite: r.finite, loops: r.loops }, r.names.join(",")).toEqual({ finite: 0, loops: 0 });
      expect(await page.getByTestId("compose-button").evaluate((b) => getComputedStyle(b).transitionDuration)).toBe("0s");
      expect(await page.evaluate(() => document.getAnimations().filter((a) => a.id !== "pill-countdown" && !(a.timeline instanceof ScrollTimeline)).length)).toBe(0);
    });
  });

  test("at 100 ms the slowest is still 100 ms; at 50 everything is quicker", async ({ app: page, server }) => {
    for (const [ms, cap] of [
      [100, 100],
      [50, 67],
    ] as const) {
      await server.backend.server.invoke("settings.update", { motionMs: ms }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await startSampler(page);
      await exercise(page);
      const r = await sampled(page);
      expect(r.finite).toBeGreaterThan(0);
      expect(r.max, `${ms}: ${r.names.join(",")}`).toBeLessThanOrEqual(cap);
    }
  });

  test("plan 195: new mail at the top of the list arrives as the rows below slide down; scrolled, nothing moves", async ({ app: page, server }) => {
    await scenario("at the top: the new row rises into place, the row it lands above slides down a row (seen mid-way)", async () => {
      await rows(page).first().waitFor();
      await recordArrivals(page);
      // every row's place, every frame: a slide passes through places between where a row was and where it goes
      await page.evaluate(() => {
        const w = window as unknown as { __tops: Map<string, number[]>; __stopTops: boolean };
        w.__tops = new Map();
        w.__stopTops = false;
        const tick = () => {
          for (const row of document.querySelectorAll<HTMLElement>("[data-testid=thread-row][data-thread-id]")) {
            const id = row.dataset.threadId!;
            if (!w.__tops.has(id)) w.__tops.set(id, []);
            w.__tops.get(id)!.push(Math.round(row.getBoundingClientRect().top * 10) / 10);
          }
          if (!w.__stopTops) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const id = await ingestConversation(server, { subject: "Llegó ahora", count: 1, unread: 1, now: E2E_NOW + 7_200_000 });
      // as a live sync says it: live mail came to it
      server.backend.notifyChanged([id], true, [id]);
      const arrived = page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
      await arrived.waitFor();
      await frames(page);
      await frames(page);
      // the row right under the new one (the Inbox's Pinned and Reminders stay above where mail arrives)
      const below = await page.evaluate((id) => {
        const all = [...document.querySelectorAll<HTMLElement>("[data-testid=thread-row][data-thread-id]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return all[all.findIndex((r) => r.dataset.threadId === String(id)) + 1]!.dataset.threadId!;
      }, id);
      const tops = await page.evaluate((below) => {
        const w = window as unknown as { __tops: Map<string, number[]>; __stopTops: boolean };
        w.__stopTops = true;
        return w.__tops.get(below)!;
      }, below);
      expect(await arrivals(page)).toContainEqual(expect.objectContaining({ thread: String(id) }));
      const [from, to] = [tops[0]!, tops.at(-1)!];
      expect(to).toBeGreaterThan(from);
      expect(tops.some((t) => t > from + 0.5 && t < to - 0.5), tops.join(",")).toBe(true);
    });
    await scenario("at the top, a row that's only changed (an undo in another window, a first sync): nothing arrives (Codex code review #1)", async () => {
      await recordArrivals(page);
      const id = await ingestConversation(server, { subject: "Restaurado en otra ventana", count: 1, unread: 1, now: E2E_NOW + 9_000_000 });
      server.backend.notifyChanged([id]);
      await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(id));
      await frames(page);
      expect(await arrivals(page)).toEqual([]);
    });
    await scenario("scrolled down: the anchor keeps the place, nothing arrives", async () => {
      const scroller = page.getByTestId("thread-list").locator("[data-keep-scroll=list]");
      await scroller.evaluate((el) => (el.scrollTop = 400));
      await recordArrivals(page);
      const id = await ingestConversation(server, { subject: "Llegó mientras leías", count: 1, unread: 1, now: E2E_NOW + 10_800_000 });
      server.backend.notifyChanged([id], true, [id]);
      // the refresh came (its row is drawn, above the rows on screen), and nothing arrived
      await page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).waitFor({ state: "attached" });
      await frames(page);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await arrivals(page)).toEqual([]);
    });
  });

  test("plans 196, 199: a sent reply arrives where the composer was, seals once as it leaves, and its copy's date arrives", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { undoSend: true }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await rows(page).first().dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("Sealed and sent");
    await recordArrivals(page);
    await page.keyboard.press("ControlOrMeta+Enter");
    const held = page.getByTestId("held-message");
    await scenario("on Send: the held message arrives; nothing seals while it can still be taken back", async () => {
      await expect(held).toBeVisible();
      await frames(page);
      const seen = await arrivals(page);
      expect(seen.filter((a) => a.id === "arrive" && a.testid === "held-message")).toHaveLength(1);
      expect(seen.filter((a) => a.id === "seal")).toHaveLength(0);
      await expect(held.getByTestId("held-seal")).toHaveClass(/scale-x-0/);
    });
    await scenario("the window ends: the line draws once across its top and stays while it's sending", async () => {
      await expect(held.getByTestId("held-status")).toHaveText("Sending…", { timeout: 8000 });
      await frames(page);
      expect((await arrivals(page)).filter((a) => a.id === "seal" && a.testid === "held-seal")).toHaveLength(1);
      const seal = held.getByTestId("held-seal");
      await expect(seal).toHaveClass(/scale-x-100/);
      // drawn (its box is measured once the draw is over)
      await seal.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const [line, card] = [(await seal.boundingBox())!, (await held.boundingBox())!];
      expect(Math.abs(line.width - card.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(line.y - card.y)).toBeLessThanOrEqual(2);
    });
    await scenario("recorded again: one animation is counted once (the recorder isn't wrapped twice)", async () => {
      await recordArrivals(page);
      await recordArrivals(page);
      await page.evaluate(() => document.body.animate([{ opacity: 1 }, { opacity: 1 }], { id: "arrive", duration: 1 }));
      expect(await arrivals(page)).toHaveLength(1);
      await recordArrivals(page);
    });
    await scenario("back in the conversation while it's still sending: the line is drawn, and nothing plays again", async () => {
      const subject = await page.getByTestId("reader-subject").textContent();
      await rows(page).nth(1).dispatchEvent("mousedown");
      await expect(page.getByTestId("reader-subject")).not.toHaveText(subject!);
      await rows(page).first().dispatchEvent("mousedown");
      await expect(held).toBeVisible();
      await frames(page);
      await expect(held.getByTestId("held-seal")).toHaveClass(/scale-x-100/);
      // (recorded afresh above: nothing new, neither the seal nor the card's arrival)
      const seen = await arrivals(page);
      expect(seen.filter((a) => a.id === "seal")).toHaveLength(0);
      expect(seen.filter((a) => a.id === "arrive" && a.testid === "held-message")).toHaveLength(0);
    });
    await scenario("its copy takes its place: only the copy's date arrives, once", async () => {
      const before = (await arrivals(page)).length;
      const { draftId } = (await server.backend.store.scheduled.list())[0]!;
      await server.backend.server.invoke("scheduled.reschedule", { draftId, sendAt: E2E_NOW - 1 }, ctx);
      await expect(held).toHaveCount(0, { timeout: 8000 });
      await frames(page);
      const after = (await arrivals(page)).slice(before);
      expect(after).toEqual([expect.objectContaining({ id: "arrive", testid: "message-date" })]);
      // (the copy's open header carries the date it arrived on)
      const date = page.getByTestId("message").last().locator("[data-message-date]");
      await expect(date).toBeVisible();
      await expect(date).toHaveCSS("opacity", "1");
    });
  });

  test("plan 196 (Codex code review #3): a reply sent from the pinned card while reading something else is simply there when its conversation opens", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { undoSend: true }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const first = await rows(page).first().getAttribute("data-thread-id");
    await rows(page).first().dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("From the pinned card");
    await page.getByTestId("compose-pin").click();
    const pinned = page.getByTestId("pinned-draft");
    await expect(pinned).toBeVisible();
    // reading another conversation, Send from the card
    await rows(page).nth(1).dispatchEvent("mousedown");
    await pinned.getByTestId("compose-body").click();
    await recordArrivals(page);
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(pinned).toHaveCount(0);
    await page.locator(`[data-testid=thread-row][data-thread-id="${first}"]`).dispatchEvent("mousedown");
    await expect(page.getByTestId("held-message")).toBeVisible();
    await frames(page);
    expect((await arrivals(page)).filter((a) => a.testid === "held-message")).toEqual([]);
  });

  test("plan 197: Review going on to another category: its name and rows arrive once; answering animates nothing new", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const [a, b] = db.all<{ id: number }>("SELECT id FROM categories ORDER BY id LIMIT 2").map((c) => c.id) as [number, number];
    // suggestions for two categories, on threads in none
    const free = db.all<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 4").map((t) => t.id);
    for (const [i, t] of free.entries()) db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, i < 2 ? a : b, Date.now());
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.getByTestId("nav-review").click();
    await expect(rows(page).first()).toBeVisible();
    await scenario("a switch: the category's name and the rows arrive, once", async () => {
      await recordArrivals(page);
      await page.getByTestId("review-category").click();
      const other = page.locator(`[data-testid^="review-category-"]`).filter({ hasNot: page.locator("[data-selected]") }).last();
      await other.click();
      await expect(rows(page).first()).toBeVisible();
      await frames(page);
      const seen = (await arrivals(page)).filter((x) => x.id === "arrive");
      expect(seen.map((x) => x.testid).sort()).toEqual(["list", "select-value"]);
    });
    await scenario("answering a suggestion: the row leaves as before, nothing arrives", async () => {
      await recordArrivals(page);
      await rows(page).first().dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("y");
      await frames(page);
      expect((await arrivals(page)).filter((x) => x.id === "arrive")).toEqual([]);
    });
  });

  test("plan 198: a list emptied by its last row leaving: its empty state arrives; one navigated to is simply there", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const thread = db.get<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 ORDER BY last_date DESC LIMIT 1")!.id;
    const category = await server.backend.store.categories.create("Una sola", "rose", { showInInbox: true });
    await server.backend.server.invoke("categories.addThreads", { categoryId: category.id, threadIds: [thread], source: "picker" }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.getByTestId(`nav-category-${category.id}`).click();
    await expect(rows(page)).toHaveCount(1);
    await scenario("trashing its one row (archived mail stays in its category): the row leaves, the empty state arrives with the spring", async () => {
      await rows(page).first().dispatchEvent("mousedown");
      await recordArrivals(page);
      await focusList(page);
      await page.keyboard.press("#");
      await expect(page.getByTestId("list-empty")).toBeVisible();
      await frames(page);
      expect((await arrivals(page)).filter((x) => x.id === "arrive")).toEqual([expect.objectContaining({ testid: "list-empty" })]);
    });
    await scenario("away and back to it, still empty: nothing arrives", async () => {
      await page.getByTestId("nav-inbox").click();
      await expect(rows(page).first()).toBeVisible();
      await recordArrivals(page);
      await page.getByTestId(`nav-category-${category.id}`).click();
      await expect(page.getByTestId("list-empty")).toBeVisible();
      await frames(page);
      expect(await arrivals(page)).toEqual([]);
    });
  });

  test("holding j never animates", async ({ app: page }) => {
    await focusList(page);
    const first = await rows(page).first().getAttribute("data-thread-id");
    await startSampler(page);
    for (let i = 0; i < 25; i++) await page.keyboard.press("j");
    await expect(page.locator("[data-testid=thread-row][aria-selected=true]")).not.toHaveAttribute("data-thread-id", first!);
    const r = await sampled(page);
    // no transition or enter/exit animation; loading loops (the reader's skeleton) may run with motion on, as §6 says
    expect(r.finite, r.names.join(",")).toBe(0);
  });
});

test.describe("motion under the OS reduced-motion preference", () => {
  test.use({ reducedMotion: "reduce" });

  test("turning reduced motion off at runtime brings animations back", async ({ app: page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  });
});

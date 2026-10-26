/**
 * Plan 18 in the renderer (production build, Chromium): autocomplete never
 * costs typing. Huge drafts (5 and 10 MB of lines, a 1 MB paragraph) with the
 * caret at the start, the middle and the end: typing with suggestions on is
 * measured against the same typing with them off, interleaved (a paired
 * measurement: whatever else the machine does affects both), and must stay
 * within 1.10× + 1 ms at the median and 1.20× + 2 ms in the slowest quarter
 * (each the median of the rounds' ratios); a suggestion appears within its
 * budget after typing stops; positions that may ask actually ask (counted),
 * others don't; the editor's DOM changes only by the ghost; a long session
 * doesn't grow the heap; the recipient list paints within a frame of a
 * keystroke. An injected 6 ms of work per keystroke must fail the paired
 * gate.
 */
import type { CDPSession, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, focusOn, readerShown, rows, test } from "./fixtures";

test.use({ fixedClock: false });

const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
/** a sentence the demo mailbox's sent mail repeats */
const HABIT = "Could you take a";
const LINE = "Hola, te paso las notas de la reunión con todos los puntos que vimos hoy.";
type Probe = Record<string, number[]>;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  // the mean of the slowest quarter, the single slowest left out (one autosave of a huge draft): a share of slow keys shows here
  const top = s.slice(Math.floor(s.length * 0.75), Math.max(Math.floor(s.length * 0.75) + 1, s.length - 1));
  const tail = top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
  return { p50: at(0.5), p90: at(0.9), p95: at(0.95), tail, max: s[s.length - 1] ?? 0, n: s.length };
};

/** A reply draft with this body on the newest conversation, opened (r) and focused. */
async function openDraft(page: Page, server: DevServer, bodyText: string) {
  const db = sqlDb(server.backend.store);
  const m = db.get<{ id: number; thread_id: number; account_id: number }>("SELECT m.id, m.thread_id, m.account_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.in_inbox = 1 ORDER BY t.last_date DESC, m.date DESC LIMIT 1")!;
  await server.backend.store.drafts.save({ accountId: m.account_id, threadId: m.thread_id, mode: "reply", to: [{ name: "Ana", email: "ana@example.com" }], cc: [], subject: "Re: x", inReplyToMessageId: m.id, bodyText }, Date.now());
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().dispatchEvent("mousedown");
  await readerShown(page, 8_000);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("r");
  const editor = page.getByTestId("compose-body");
  await focusOn(page, "compose-body", 60_000);
  // the backend's models are warm (a draft opened warms them; the first build is over)
  await server.backend.autocomplete.warm();
  await server.backend.autocomplete.idle();
  return editor;
}

/** The caret at the end of the top-level line `index` (-1: the last), or at `offset` into it, set in the editor's state (a DOM selection would race the editor reading it in a huge draft). */
async function caretAt(page: Page, index: number, offset?: number) {
  expect(await page.evaluate(([index, offset]) => (window as unknown as { __terno: { setComposerCaret(i: number, o?: number): boolean } }).__terno.setComposerCaret(index!, offset ?? undefined), [index, offset ?? null] as const)).toBe(true);
  await page.waitForTimeout(60);
}

/** Measures each typed character: keydown → the editor's transaction, and → the frame after it (painted). */
async function installKeyTimer(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __kt: { handled: number[]; frame: number[]; keyAt: number }; __composer?: Probe; __ktOn?: boolean };
    w.__kt = { handled: [], frame: [], keyAt: 0 };
    if (w.__ktOn) return;
    w.__ktOn = true;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key.length !== 1) return;
        const t0 = performance.now();
        w.__kt.keyAt = t0;
        const waitTx = () => {
          const done = (w.__composer?.tx ?? []).find((t) => t >= t0);
          if (done === undefined) return void setTimeout(waitTx, 0);
          w.__kt.handled.push(done - t0);
          requestAnimationFrame(() => setTimeout(() => w.__kt.frame.push(performance.now() - t0), 0));
        };
        setTimeout(waitTx, 0);
      },
      { capture: true },
    );
  });
}

const resetProbe = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __kt: { handled: number[]; frame: number[] }; __composer?: Probe };
    w.__kt.handled = [];
    w.__kt.frame = [];
    if (w.__composer) for (const k of ["tx", "ghost-request", "ghost-shown", "ghost-placed"]) w.__composer[k] = [];
  });
const readTimes = (page: Page) => page.evaluate(() => (window as unknown as { __kt: { handled: number[]; frame: number[] } }).__kt);
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __composer?: Probe }).__composer ?? {});
const setSuggestions = (page: Page, on: boolean) => page.evaluate((on) => (window as unknown as { __terno: { setComposeSuggestions(on: boolean): void } }).__terno.setComposeSuggestions(on), on);

/**
 * Typing the habit with suggestions on, then the same with them off, `rounds`
 * times (each round types on the caret's fresh line, then removes what it
 * typed). 90 ms between keys: every key's suggestion is asked for and shown,
 * the worst case for what ours costs while typing.
 */
async function paired(page: Page, rounds: number) {
  const on: number[] = [];
  const off: number[] = [];
  /** each round's on/off ratio of medians: the two bursts are seconds apart, so the machine's load is about the same for both */
  const ratios: number[] = [];
  /** and of the slowest quarters' means: a regression on a share of the keys (one in four) moves these, not the medians */
  const tails: number[] = [];
  let requests = 0;
  for (let r = 0; r < rounds; r++) {
    // the order alternates (on first, then off first): neither side always comes first
    const round: Record<string, number> = {};
    for (const enabled of r % 2 ? [false, true] : [true, false]) {
      await setSuggestions(page, enabled);
      await resetProbe(page);
      await page.keyboard.type(HABIT, { delay: 90 });
      // a huge draft takes tens of ms a key: the suggestion is asked 60 ms after the last one is handled
      await page.waitForTimeout(600);
      const t = await readTimes(page);
      // every key was measured, in the open draft (an Esc here would collapse it: the next keys would type nowhere)
      expect(t.handled.length, "keys measured in the burst").toBeGreaterThanOrEqual(HABIT.length - 1);
      await expect(page.getByTestId("compose-body")).toBeFocused();
      (enabled ? on : off).push(...t.handled);
      round[enabled ? "on" : "off"] = stats(t.handled).p50;
      round[enabled ? "onTail" : "offTail"] = stats(t.handled).tail;
      if (enabled) requests += (await probe(page))["ghost-request"]?.length ?? 0;
      // back to where it was (a deletion dismisses a ghost)
      for (let i = 0; i < HABIT.length; i++) await page.keyboard.press("Backspace");
    }
    ratios.push(round.on! / round.off!);
    tails.push(round.onTail! / round.offTail!);
  }
  await setSuggestions(page, true);
  return { on: stats(on), off: stats(off), ratio: stats(ratios).p50, tail: stats(tails).p50, requests };
}

/**
 * With suggestions vs without, paired: the median over rounds of each
 * round's ratio of medians stays within 1.10 plus 1 ms, so whatever else the
 * machine does (it affects both bursts of a round alike) doesn't decide it,
 * while 6 ms of our own work a key does. Pooled p50/p90/p95 are reported.
 */
const pairedGate = (r: Awaited<ReturnType<typeof paired>>, label: string) => {
  const limit = { p50: 1.1 + 1 / Math.max(1, r.off.p50), tail: 1.2 + 2 / Math.max(1, r.off.tail) };
  console.log(`${label}: keystroke → transaction, with / without suggestions: per-round ratio p50 ${r.ratio.toFixed(3)} (gate ${limit.p50.toFixed(3)}), slowest quarter ${r.tail.toFixed(3)} (gate ${limit.tail.toFixed(3)}); pooled p50 ${r.on.p50.toFixed(1)} / ${r.off.p50.toFixed(1)}, p90 ${r.on.p90.toFixed(1)} / ${r.off.p90.toFixed(1)}, p95 ${r.on.p95.toFixed(1)} / ${r.off.p95.toFixed(1)} ms; ${r.requests} requests`);
  return limit;
};
const withinGate = (r: Awaited<ReturnType<typeof paired>>, limit: { p50: number; tail: number }) => r.ratio <= limit.p50 * MULT && r.tail <= limit.tail * MULT;

async function lines(megabytes: number) {
  const n = Math.ceil((megabytes * 1_000_000) / (LINE.length + 8));
  return Array.from({ length: n }, (_, i) => `${i} ${LINE}`).join("\n");
}

/** Chinese lines: three bytes a character in UTF-8, so a 10 MB draft stays within the 5M-character draft limit (plan 16). */
const CHINESE = "你好，我把会议的笔记发给你，包括我们今天讨论的所有要点和下一步的安排。";
function chineseLines(megabytes: number) {
  const n = Math.ceil((megabytes * 1_000_000) / (new TextEncoder().encode(CHINESE).length + 8));
  return Array.from({ length: n }, (_, i) => `${i} ${CHINESE}`).join("\n");
}

for (const mb of [5, 10]) {
  test(`a ${mb} MB draft: suggestions at the start, middle and end cost typing nothing beyond the paired gate, and appear in time`, async ({ app: page, server }) => {
    test.setTimeout(1_500_000);
    const body = mb === 10 ? chineseLines(10) : await lines(mb);
    expect(body.length, "within the draft limit (characters)").toBeLessThanOrEqual(5_000_000);
    expect(new TextEncoder().encode(body).length, "draft size in UTF-8").toBeGreaterThanOrEqual(mb * 0.95 * 1_000_000);
    await openDraft(page, server, body);
    await installKeyTimer(page);
    const blocks = await page.getByTestId("compose-body").evaluate((el) => el.querySelectorAll(":scope > p").length);
    for (const [where, index] of [
      ["start", 0],
      ["middle", Math.floor(blocks / 2)],
      ["end", -1],
    ] as const) {
      await caretAt(page, index);
      // a fresh line under it: room for the ghost on the caret's line
      await page.keyboard.press("Enter");
      const r = await paired(page, mb === 10 ? 3 : 4);
      const gate = pairedGate(r, `${mb} MB draft, caret at the ${where}`);
      expect(withinGate(r, gate), `${where}: typing with suggestions vs without`).toBe(true);
      // each position is at the end of its line: it asks (a gate that silently asked nothing would pass by doing nothing)
      expect(r.requests, `${where}: suggestions were asked for`).toBeGreaterThan(0);
      // a suggestion appears after a pause, within budget: the best of three tries (a multi-megabyte save landing at
      // that moment holds the request behind it, plan 18 as shipped; it doesn't land every time)
      let latency = Infinity;
      for (let attempt = 0; attempt < 3 && latency > 120 * MULT; attempt++) {
        await expect(page.getByTestId("draft-status")).toHaveText(/saved/i, { timeout: 60_000 });
        await resetProbe(page);
        await page.keyboard.type(HABIT, { delay: 30 });
        await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toHaveAttribute("data-ghost", /^ look/, { timeout: 10_000 });
        // typing stopped → shown: the 60 ms pause, then the request (window, RPC, model) and the frame that places it
        latency = Math.min(
          latency,
          await page.evaluate((delay) => {
            const w = window as unknown as { __composer: Probe };
            const placed = w.__composer["ghost-placed"]!.at(-1)!;
            const asked = w.__composer["ghost-request"]!.filter((t) => t <= placed).at(-1)!;
            return placed - asked + delay;
          }, 60),
        );
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toHaveCount(0);
        for (let i = 0; i < HABIT.length; i++) await page.keyboard.press("Backspace");
      }
      console.log(`${mb} MB draft, caret at the ${where}: typing stopped → ghost placed ${latency.toFixed(1)} ms (60 ms of it the pause before asking)`);
      expect(latency, `${where}: a suggestion after typing stops`).toBeLessThanOrEqual(120 * MULT);
    }
  });
}

test("a 1 MB paragraph: at its end, suggestions cost typing nothing beyond the paired gate", async ({ app: page, server }) => {
  test.setTimeout(600_000);
  const paragraph = "palabra ".repeat(125_000);
  await openDraft(page, server, paragraph);
  await installKeyTimer(page);
  await caretAt(page, 0);
  const end = await paired(page, 4);
  const gate = pairedGate(end, "1 MB paragraph, caret at the end");
  expect(withinGate(end, gate), "typing with suggestions vs without").toBe(true);
  expect(end.requests).toBeGreaterThan(0);
});

test("a 250 KB paragraph: at its start and middle (text after the caret) nothing is asked", async ({ app: page, server }) => {
  test.setTimeout(600_000);
  await openDraft(page, server, "palabra ".repeat(31_250).trimEnd());
  await installKeyTimer(page);
  // typing inside a huge paragraph re-lays out all of it on every key (Chromium's cost): a few keys only
  for (const [where, offset] of [
    ["start", 0],
    ["middle", 125_000],
  ] as const) {
    await caretAt(page, 0, offset);
    await resetProbe(page);
    await page.keyboard.type("Could", { delay: 90 });
    await page.waitForTimeout(300);
    expect((await probe(page))["ghost-request"] ?? [], `${where}: not at a line end, nothing is asked`).toHaveLength(0);
    await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toHaveCount(0);
  }
});

test("a suggestion doesn't change the editor's DOM at all (it's a layer beside it); a 1 MB paste asks nothing", async ({ app: page, server }) => {
  test.setTimeout(300_000);
  await openDraft(page, server, await lines(2));
  await installKeyTimer(page);
  await caretAt(page, -1);
  await page.keyboard.press("Enter");
  // no save of the 2 MB draft in flight (it would hold the suggestion's request behind it)
  await expect(page.getByTestId("draft-status")).toHaveText(/saved/i, { timeout: 60_000 });
  await page.keyboard.type(HABIT.slice(0, -1), { delay: 20 });
  await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toBeVisible({ timeout: 15_000 });
  // (Esc only with a suggestion showing: otherwise it collapses the draft)
  await page.keyboard.press("Escape");
  // watch the editor while the next suggestion arrives and shows
  await page.getByTestId("compose-body").evaluate((el) => {
    const w = window as unknown as { __mut: string[] };
    w.__mut = [];
    new MutationObserver((list) => {
      for (const m of list) {
        // a class written again with the same value (the editor's own is-empty/rt-huge upkeep on each change) isn't a change
        if (m.type === "attributes" && m.oldValue === (m.target as HTMLElement).getAttribute(m.attributeName!)) continue;
        w.__mut.push(`${m.type} ${(m.target as HTMLElement).nodeName} +${m.addedNodes.length} -${m.removedNodes.length}`);
      }
    }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ["class", "style", "data-ghost"] });
  });
  await page.keyboard.type("a");
  await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toHaveCount(0);
  const muts = await page.evaluate(() => (window as unknown as { __mut: string[] }).__mut);
  // the typed "a" changes a text node; the suggestion showing and going changes no element and no attribute
  expect(muts.filter((m) => !m.startsWith("characterData")), muts.join("\n")).toEqual([]);
  // a paste of 1 MB: no request (pastes never ask)
  await resetProbe(page);
  await page.getByTestId("compose-body").evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "pegado ".repeat(150_000));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  expect((await probe(page))["ghost-request"] ?? []).toHaveLength(0);
});

async function heapUsed(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  return (await cdp.send("Runtime.getHeapUsage")).usedSize;
}

test("300 suggestions accepted, dismissed and undone don't grow the heap", async ({ app: page, server }) => {
  test.setTimeout(600_000);
  await openDraft(page, server, "Hola,\n");
  await caretAt(page, -1);
  const cdp = await page.context().newCDPSession(page);
  const cycle = async (i: number) => {
    await page.keyboard.type(HABIT, { delay: 5 });
    await expect(page.locator("[data-testid=compose-ghost]:not([hidden])")).toBeVisible({ timeout: 5000 });
    if (i % 3 === 0) {
      await page.keyboard.press("Tab");
      await page.keyboard.press("ControlOrMeta+z");
    } else if (i % 3 === 1) await page.keyboard.press("Escape");
    else await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
  };
  for (let i = 0; i < 30; i++) await cycle(i);
  const before = await heapUsed(cdp);
  for (let i = 0; i < 300; i++) await cycle(i);
  const after = await heapUsed(cdp);
  console.log(`300 suggestion cycles: heap ${((after - before) / 1048576).toFixed(2)} MiB`);
  expect(after - before, "heap growth over 300 cycles").toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("recipients (plan 29): with 200 chips in the field, a keystroke is painted within a frame (p95, best of 3) and renders no chip", async ({ app: page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  const to = page.getByTestId("compose-to");
  await expect(to).toBeFocused();
  await to.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", Array.from({ length: 200 }, (_, i) => `Persona ${i} <persona${i}@example.com>`).join(", "));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("recipient-chip")).toHaveCount(200);
  await page.evaluate(() => {
    const w = window as unknown as { __kp: number[] };
    w.__kp = [];
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key.length !== 1) return;
        const t0 = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.__kp.push(performance.now() - t0), 0));
      },
      { capture: true },
    );
  });
  const chipRenders = () => page.evaluate(() => (window as unknown as { __renders?: Record<string, number> }).__renders?.RecipientChip ?? 0);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => ((window as unknown as { __kp: number[] }).__kp = []));
    const before = await chipRenders();
    // words nobody in the mailbox matches (no list): the field's own cost, not the suggestions'
    for (const word of ["qzx", "wvq", "xjq", "zqv"]) {
      await page.keyboard.type(word, { delay: 60 });
      await to.fill("");
    }
    expect(await chipRenders(), "chip renders while typing").toBe(before);
    const s = stats(await page.evaluate(() => (window as unknown as { __kp: number[] }).__kp));
    console.log(`200 chips, round ${round + 1}: keystroke → painted p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms (${s.n})`);
    expect(s.n).toBeGreaterThanOrEqual(10);
    best = Math.min(best, s.p95);
    if (best <= 16.7 * MULT) break;
  }
  expect(best, "keystroke → painted p95 with 200 chips").toBeLessThanOrEqual(16.7 * MULT);
});

test("recipients: a keystroke to its suggestions painted within a frame (p95, best of 3)", async ({ app: page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  const to = page.getByTestId("compose-to");
  await expect(to).toBeFocused();
  // the index is warm
  await page.keyboard.type("a");
  await expect(page.locator("[data-testid=recipient-suggestions]:not([hidden])")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __rt: number[]; __rt0: number };
    w.__rt = [];
    document.addEventListener("keydown", (e) => e.key.length === 1 && (w.__rt0 = performance.now()), { capture: true });
    // the list exists only while it shows: watch the page for it appearing or changing
    const inList = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest("[data-testid=recipient-suggestions]") != null || (n instanceof Element && n.querySelector("[data-testid=recipient-suggestions]") != null);
    new MutationObserver((records) => {
      const t0 = w.__rt0;
      if (!t0 || !records.some((r) => inList(r.target) || [...r.addedNodes].some(inList))) return;
      w.__rt0 = 0;
      requestAnimationFrame(() => setTimeout(() => w.__rt.push(performance.now() - t0), 0));
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => ((window as unknown as { __rt: number[] }).__rt = []));
    for (const word of ["mar", "jos", "luc", "and", "sof", "car", "gab", "val"]) {
      await to.fill("");
      await page.keyboard.type(word, { delay: 60 });
      await page.waitForTimeout(80);
    }
    const s = stats(await page.evaluate(() => (window as unknown as { __rt: number[] }).__rt));
    console.log(`recipients round ${round + 1}: keystroke → list painted p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms (${s.n})`);
    expect(s.n, "keystrokes measured").toBeGreaterThanOrEqual(20);
    best = Math.min(best, s.p95);
    if (best <= 16.7 * MULT) break;
  }
  expect(best, "keystroke → suggestions painted p95").toBeLessThanOrEqual(16.7 * MULT);
});

test("injected regression: 6 ms of extra work per keystroke in the ghost plugin fails the paired gate", async ({ app: page, server }) => {
  test.setTimeout(300_000);
  await openDraft(page, server, await lines(1));
  await installKeyTimer(page);
  await caretAt(page, -1);
  await page.keyboard.press("Enter");
  // the injection only acts with suggestions on: the paired measurement sees it
  await page.evaluate(() => ((window as unknown as { __ternoInject?: string }).__ternoInject = "ghost-busy"));
  const r = await paired(page, 3);
  const gate = pairedGate(r, "injected 6 ms per keystroke");
  await page.evaluate(() => delete (window as unknown as { __ternoInject?: string }).__ternoInject);
  expect(withinGate(r, gate)).toBe(false);
});

test("injected regression: 10 ms on one key in four fails the paired tail gate (the medians alone would pass)", async ({ app: page, server }) => {
  test.setTimeout(300_000);
  await openDraft(page, server, await lines(1));
  await installKeyTimer(page);
  await caretAt(page, -1);
  await page.keyboard.press("Enter");
  await page.evaluate(() => ((window as unknown as { __ternoInject?: string }).__ternoInject = "ghost-busy-sometimes"));
  const r = await paired(page, 4);
  const gate = pairedGate(r, "injected 10 ms on one key in four");
  await page.evaluate(() => delete (window as unknown as { __ternoInject?: string }).__ternoInject);
  expect(withinGate(r, gate)).toBe(false);
  expect(r.tail).toBeGreaterThan(gate.tail * MULT);
});

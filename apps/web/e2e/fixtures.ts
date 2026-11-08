import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { sqlDb, startDevServer, type DevServer } from "../../backend-dev/src/server";
import { TIPS, tipKey } from "../src/lib/tips";
import type { IncomingMessage } from "@terno/store";
import type { DesignId, DevAiKeys } from "@terno/core";
import { seedPrintFixtures } from "@terno/backend";
import type { PrintFixtureKey } from "@terno/mock-data";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";
import { iconStub, type IconStub } from "./icon-stub";

export { expect };

/**
 * Forward from the reader's toolbar; Reply all, which isn't in the toolbar (plan 158), from the bar at the conversation's end,
 * or with a draft open (no bar then) from the palette, which converts it.
 */
export async function respond(page: Page, mode: "reply-all" | "forward"): Promise<void> {
  if (mode === "forward") return page.getByTestId("action-forward").click();
  const bar = page.getByTestId("quick-reply-all");
  if (await bar.isVisible()) return bar.click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("palette-input").fill("Reply all");
  await page.getByRole("option", { name: /^Reply all/ }).first().click();
}

/** The same with the keyboard alone. */
export async function respondByKeys(page: Page, mode: "reply-all" | "forward"): Promise<void> {
  await page.getByTestId(mode === "reply-all" ? "quick-reply-all" : `action-${mode}`).focus();
  await page.keyboard.press("Enter");
}

/** A message the backend handed to SMTP (plan 16: the desktop's real send path into an in-process server). */
export interface CapturedMail {
  from: string;
  raw: string;
  rcpt: string[];
}

/**
 * The demo provider, except that a send goes through the desktop's real path:
 * nodemailer builds the MIME (buildRaw) and talks SMTP to an in-process
 * smtp-server that keeps what it receives.
 */
async function smtpRegistry(): Promise<{ registry: import("@terno/mail").ProviderRegistry; received: CapturedMail[]; close(): Promise<void> }> {
  const { SMTPServer } = await import("smtp-server");
  const { createDemoProvider, demoRegistry, sendViaSmtp } = await import("@terno/mail");
  const received: CapturedMail[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth: (_a, _s, cb) => cb(null, { user: "e2e" }),
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", raw: Buffer.concat(chunks).toString("utf8"), rcpt: session.envelope.rcptTo.map((r) => r.address) });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const port = (smtp.server.address() as { port: number }).port;
  const registry: import("@terno/mail").ProviderRegistry = {
    ...demoRegistry,
    create(ctx) {
      const demo = createDemoProvider(ctx, 5);
      return {
        ...demo,
        async execute(op) {
          if (op.kind !== "send") return demo.execute(op);
          await sendViaSmtp({ host: "127.0.0.1", port, secure: false, user: "e2e", password: "e2e", allowInsecure: true }, op.payload as never);
          return { providerMsgId: `smtp-${op.id}` };
        },
      };
    },
  };
  return { registry, received, close: () => new Promise<void>((r) => smtp.close(() => r())) };
}

/** plan 20: the demo provider behind a network the test switches off (sync fails as unreachable) or holds (a slow retry) */
export interface TestNetwork {
  down: boolean;
  /** while set, a sync waits for it (to see "Reconnecting…") */
  hold: Promise<void> | null;
  /**
   * plan 25: addresses whose server refuses the saved sign-in (sync and actions) until the account signs in
   * again: with the password `SIGN_IN_PASSWORD`, or through the fake Google (which signs in as `google`, else
   * as the address it was asked for)
   */
  refused: Set<string>;
  google: string | null;
  /** plan 41: mail the next sync pass of its account hands over as live (new since the last pass) */
  incoming: IncomingMessage[];
}

/** plan 123: the Google client a test build carries (Terno's own is the only way to connect Gmail) */
export const E2E_GOOGLE_CLIENT = "e2e.apps.googleusercontent.com";
export const E2E_GOOGLE = { preferred: E2E_GOOGLE_CLIENT, clients: [{ clientId: E2E_GOOGLE_CLIENT, clientSecret: "" }] };

/** plan 25: the password the fake IMAP server accepts */
export const SIGN_IN_PASSWORD = "right-password";
const SIGNED_IN = "signed-in-again";

async function networkRegistry(net: TestNetwork): Promise<import("@terno/mail").ProviderRegistry> {
  const { createDemoProvider, demoRegistry, ProviderAuthError, ProviderError } = await import("@terno/mail");
  const { L } = await import("@terno/i18n");
  // a sign-in done in this test stores a secret the fake server accepts (demo accounts have none)
  const refusing = async (ctx: import("@terno/mail").ProviderContext) =>
    net.refused.has(ctx.account.email) && (await ctx.getSecret(ctx.account.kind === "imap" ? "password" : "refreshToken")) !== (ctx.account.kind === "imap" ? SIGN_IN_PASSWORD : SIGNED_IN);
  const refusal = (ctx: import("@terno/mail").ProviderContext) =>
    new ProviderAuthError(ctx.account.kind === "imap" ? L("errors.imap.loginFailed", { detail: "Invalid credentials (Failure)" }) : L("errors.gmail.revoked"));
  return {
    ...demoRegistry,
    create(ctx) {
      const demo = createDemoProvider(ctx, 5);
      return {
        ...demo,
        async sync(sink) {
          if (net.hold) await net.hold;
          if (net.down) throw ProviderError.network("IMAP: connect ECONNREFUSED");
          if (await refusing(ctx)) throw refusal(ctx);
          const mine = net.incoming.filter((m) => m.accountId === ctx.account.id);
          if (mine.length) {
            net.incoming = net.incoming.filter((m) => m.accountId !== ctx.account.id);
            await sink.ingest(mine, { live: true });
          }
          return demo.sync(sink);
        },
        async execute(op) {
          if (await refusing(ctx)) throw refusal(ctx);
          return demo.execute(op);
        },
        // the login a recheck of the saved password makes (plan 25)
        async verify() {
          if (await refusing(ctx)) throw refusal(ctx);
          return demo.verify();
        },
      };
    },
    async verifyImap(_config, password) {
      if (password !== SIGN_IN_PASSWORD) throw new ProviderAuthError(L("errors.imap.loginFailed", { detail: "Invalid credentials (Failure)" }));
    },
    async connectGmail(o) {
      await o.openExternal("https://accounts.google.com/o/oauth2/v2/auth?e2e");
      const email = net.google ?? o.loginHint ?? "someone@gmail.com";
      return { email, name: "Luis Cordero", refreshToken: SIGNED_IN, sub: `sub-${email}`, emailVerified: true };
    },
  };
}

/** plan 96: the one-click POSTs a test's backend made (none leave the machine), and the status they get */
export interface UnsubscribeRecorder {
  posted: string[];
  status: number;
  post(url: URL): Promise<{ status: number }>;
}

/** the `server` fixture: the dev backend and the test's knobs */
export type DevServerFixture = Fixtures["server"];

interface Fixtures {
  /** freeze Date for deterministic list dates (off for perf: the fake clock coarsens performance.now) */
  fixedClock: boolean;
  /** backend-dev knobs: a fresh install with no mailbox, and owner claims through the demo registry */
  /** noGoogle (plan 123): a build without Terno's Google client, which can't connect Gmail */
  backendOptions: { empty?: boolean; ownerClaims?: boolean; agentSocket?: boolean; smtpCapture?: boolean; network?: boolean; noGoogle?: boolean; /** plan 146: a local build's keys; every host refused, so nothing they could reach is reached */ devAi?: DevAiKeys };
  /** the design the app opens in (plan 15): each Playwright project sets its own; null leaves the install's default (Lumen) */
  design: DesignId | null;
  /** plan 24: the layout the app opens in (null: the install's default, Split) */
  layout: "split" | "list" | null;
  /** plan 22: website icons are on by default; tests keep them off (stable baselines) unless they opt in */
  siteIcons: boolean;
  /** plan 113: education tips, all seen already unless a test opts in (one would sit over the list) */
  tips: boolean;
  /** plan 158: the composer's format bar starts closed; a spec about its controls starts with it open (Aa still decides after that) */
  formatBar: boolean;
  /** plan 145: Today's row, hidden unless a test opts in: the demo has an AI provider, and every screen would show it (today.spec holds it in every design) */
  today: boolean;
  server: DevServer & { smtp: CapturedMail[]; net: TestNetwork; icons: IconStub; unsubscribes: UnsubscribeRecorder };
  /** the app, loaded, connected and showing the inbox */
  app: Page;
}

export const test = base.extend<Fixtures>({
  fixedClock: [true, { option: true }],
  backendOptions: [{}, { option: true }],
  design: ["macos", { option: true }],
  layout: [null, { option: true }],
  siteIcons: [false, { option: true }],
  tips: [false, { option: true }],
  formatBar: [false, { option: true }],
  today: [false, { option: true }],
  server: async ({ backendOptions, siteIcons, today }, use) => {
    const template = process.env[TEMPLATE_ENV];
    if (!template) throw new Error("global setup did not seed a template database");
    const dir = mkdtempSync(join(tmpdir(), "terno-e2e-"));
    if (!backendOptions.empty) {
      copyFileSync(template, join(dir, "terno.db"));
      // the template's search snapshot too (written on close), so each backend restores instead of building
      if (existsSync(`${template}.search`)) copyFileSync(`${template}.search`, join(dir, "terno.db.search"));
    }
    const capture = backendOptions.smtpCapture ? await smtpRegistry() : null;
    const net: TestNetwork = { down: false, hold: null, refused: new Set(), google: null, incoming: [] };
    const providers = backendOptions.network ? await networkRegistry(net) : capture?.registry;
    // plan 20: the retry after a first failure comes in a second, then a minute (time enough to look)
    const connectivity = backendOptions.network ? { delays: [1000, 60_000] } : undefined;
    // plan 22: website icons never reach the internet from a test (a few seeded sites have icons, the rest 404)
    const icons = iconStub();
    // plan 96: one-click unsubscribes never reach the internet either: recorded, answered 200
    const unsubscribes: UnsubscribeRecorder = { posted: [], status: 200, post: async (url) => (unsubscribes.posted.push(url.href), { status: unsubscribes.status }) };
    const server = await startDevServer({ ...(backendOptions.devAi ? { devAi: backendOptions.devAi, lookup: async () => { throw new Error("no network in e2e"); } } : {}), port: 0, dataDir: dir, token: "e2e", now: () => E2E_NOW, autoSync: true, seed: !backendOptions.empty, ownerClaims: backendOptions.ownerClaims, agentSocket: backendOptions.agentSocket, providers, connectivity, iconTransport: icons, unsubscribeTransport: unsubscribes, openExternal: backendOptions.network ? async () => {} : undefined, googleClients: backendOptions.noGoogle ? null : E2E_GOOGLE });
    if (!siteIcons) await server.backend.server.invoke("settings.update", { senderIcons: false }, { clientId: "setup", origin: "dev" as const });
    if (!today) await server.backend.server.invoke("settings.update", { today: { show: false } }, { clientId: "setup", origin: "dev" as const });
    // plan 158: Send's five seconds would be every send's, in every test: a test about them turns it on
    await server.backend.server.invoke("settings.update", { undoSend: false }, { clientId: "setup", origin: "dev" as const });
    await use(Object.assign(server, { smtp: capture?.received ?? [], net, icons, unsubscribes }));
    // Backend.stop() doesn't wait for an in-flight ops batch; let it settle first.
    const b = server.backend as unknown as { workerRunning: boolean };
    for (let i = 0; i < 100 && b.workerRunning; i++) await new Promise((r) => setTimeout(r, 20));
    await server.close();
    await capture?.close();
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ page, server, fixedClock, backendOptions, design, layout, tips, formatBar }, use) => {
    if (fixedClock) await page.clock.setFixedTime(new Date(E2E_NOW));
    if (!tips) await page.addInitScript((keys) => keys.forEach((k) => localStorage.setItem(k, "shown")), TIPS.map(tipKey));
    if (formatBar) await page.addInitScript(() => { if (localStorage.getItem("terno:format-bar") === null) localStorage.setItem("terno:format-bar", "shown"); });
    // a project's design in its own colors, as its baselines show it (plan 98's GitHub defaults are a new install's: `design: null`)
    if (design) await server.backend.server.invoke("settings.update", { design, lightTheme: "design", darkTheme: "design" }, { clientId: "setup", origin: "dev" as const });
    if (layout) await server.backend.server.invoke("settings.update", { layout }, { clientId: "setup", origin: "dev" as const });
    await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
    await page.locator("[data-ready]").waitFor();
    if (!backendOptions.empty) await rows(page).first().waitFor();
    await use(page);
  },
});

/**
 * One scenario of a test that merges several on one backend and page (plan 139): named in the report, and a failure is
 * recorded without stopping the scenarios after it, so a merge hides nothing. Steps that depend on each other use test.step.
 */
/** Where a design keeps its filters in a menu: the header's one control, a choice in it. */
export async function pickFilter(page: Page, filter: "all" | "unread" | "people" | "waiting" | "attachments" | "starred"): Promise<void> {
  // plan 158: All and Unread are one click, on the header's segmented control; the rest are in More filters
  if (filter === "all" || filter === "unread") return page.getByTestId(`filter-segment-${filter}`).click();
  await page.getByTestId("filter-menu").click();
  await page.getByTestId(`filter-option-${filter}`).click();
}

/** The header's filter state where filters are a menu: All, Unread, or the More filter that's on. */
export async function expectFilter(page: Page, filter: "all" | "unread" | "people" | "waiting" | "attachments" | "starred", name?: string): Promise<void> {
  for (const f of ["all", "unread"] as const) await expect(page.getByTestId(`filter-segment-${f}`)).toHaveAttribute("aria-pressed", String(f === filter));
  const more = page.getByTestId("filter-menu");
  if (filter === "all" || filter === "unread") await expect(more).not.toHaveAttribute("data-active");
  else {
    await expect(more).toHaveAttribute("data-active");
    if (name) await expect(more).toHaveAccessibleName(`More filters: ${name} is on`);
  }
}

/** A filing's or an archive's snack is one line: what could follow from it opens here (the keys stay the list's). */
export async function openOffers(page: Page): Promise<void> {
  const more = page.getByTestId("snackbar-similar");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await focusList(page);
}

export async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await test.step(name, body);
  } catch (e) {
    expect.soft(e instanceof Error ? e.message : String(e), name).toBe("");
  }
}

/** The app again on the same backend, for a scenario that needs a clean page: focus, selection, dialogs and open drafts go, what the backend holds stays. */
export async function fresh(page: Page): Promise<void> {
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
}

/** Also without what this window remembers (the account left open, the scope): as a test starts, on the same backend. */
export async function freshStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await fresh(page);
}

/** And no drafts: a draft left open is discarded through its own control (a reload would save it again), what's left in the store goes. */
export async function freshNoDrafts(page: Page, server: DevServer): Promise<void> {
  const discard = page.getByTestId("compose-discard");
  while (await discard.count()) await discard.first().click();
  await freshStart(page);
  const left = await server.backend.store.drafts.list();
  if (!left.length) return;
  for (const d of left) await server.backend.store.drafts.delete(d.id, d.generation);
  await fresh(page);
}

/**
 * Axe on what's on screen, or these parts of it (mail frames aside: legacy mode, which doesn't open a page per call). Names,
 * roles and structure can't change between light and dark, so dark reads contrast alone. The app must be following the OS.
 */
export async function axeBothModes(page: Page, ...scopes: string[]): Promise<void> {
  const read = async (axe: AxeBuilder, mode: string) => {
    for (const scope of scopes) axe = axe.include(scope);
    const { violations } = await axe.exclude("iframe").setLegacyMode().analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`), mode).toEqual([]);
  };
  const html = page.locator("html");
  await read(new AxeBuilder({ page }), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/\bdark\b/);
  await read(new AxeBuilder({ page }).withRules(["color-contrast"]), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/\bdark\b/);
}

export const rows = (page: Page): Locator => page.getByTestId("thread-row");

/** A recipient field's chips (plan 34): `field` is the input's test id ("compose-to"). */
export const chipsOf = (page: Page, field: string): Locator => page.getByTestId(`${field}-field`).getByTestId("recipient-chip");

/** Every address in a recipient field, in order (focused first: a long field shows them all only then). */
export async function recipientEmails(page: Page, field: string): Promise<string[]> {
  if ((await page.getByTestId(`${field}-field`).getAttribute("data-collapsed")) !== null) await page.getByTestId(field).focus();
  return chipsOf(page, field).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.email ?? ""));
}

/** Types recipients into a field and commits them (Enter), as a person would. */
export async function addRecipients(page: Page, field: string, text: string): Promise<void> {
  await page.getByTestId(field).fill(text);
  await page.getByTestId(field).press("Enter");
}
/** the open thread (the list's cursor) */
export const selectedRow = (page: Page): Locator => page.locator("[data-testid=thread-row][data-cursor]");

export const rowSubject = (row: Locator): Locator => row.getByTestId("row-subject");
export const rowFrom = (row: Locator): Locator => row.getByTestId("row-from");

export async function selectedId(page: Page): Promise<string | null> {
  return selectedRow(page).getAttribute("data-thread-id");
}

/** Waits until the reader shows the currently selected thread. */
export async function readerSubject(page: Page): Promise<string> {
  const subject = page.getByTestId("reader-subject");
  await subject.waitFor();
  return (await subject.textContent()) ?? "";
}

/** Clicks a row by index and waits for the reader. */
/**
 * Plan 122: a time typed into a TimeField as a person would: its hour segment, two-digit hour and minute (so 1 and 10
 * never run together), then A or P in a 12-hour locale.
 */
export async function typeTime(field: Locator, hour: number, minute: number, period?: "AM" | "PM"): Promise<void> {
  await field.locator("[role=spinbutton]").first().click();
  await field.page().keyboard.type(`${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}${period ? period[0] : ""}`);
}

/** A TimeField's text as it reads (without the bidi isolates React Aria wraps its digits in). */
export const timeText = (field: Locator): Promise<string> => field.evaluate((el) => (el.textContent ?? "").replace(/[\u2066-\u2069\u200e\u200f]/g, "").replace(/\s+/g, " ").trim());

export async function openRow(page: Page, index: number): Promise<string> {
  const row = rows(page).nth(index);
  const id = (await row.getAttribute("data-thread-id"))!;
  await row.dispatchEvent("mousedown");
  await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
  await readerSubject(page);
  return id;
}

/**
 * Selects several rows like a hand would: a click on the first (it opens and
 * becomes the selection), then ⌘-click (Ctrl-click off Mac) on each other.
 */
export async function selectRows(page: Page, ids: readonly (string | number)[]): Promise<void> {
  const [first, ...rest] = ids;
  await page.locator(`[data-thread-id="${first}"]`).dispatchEvent("mousedown", { button: 0 });
  for (const id of rest) await page.locator(`[data-thread-id="${id}"]`).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator("[data-testid=thread-row][data-checked]")).toHaveCount(ids.length > 1 ? ids.length : 0);
  await focusList(page);
}

/**
 * Waits, reading one thing, for the reader to show a conversation and for
 * focus to be in the element with `testId`. On a page holding a multi-MB
 * draft, a polled `expect` that misses walks the whole page for its message
 * (Playwright's aria snapshot, a forced layout per element): 20–40 s with the
 * page held, past any timeout, although the next poll would have passed.
 */
export async function readerShown(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(() => document.querySelector("[data-testid=reader-subject]")?.checkVisibility() === true, null, { timeout });
}
export async function focusOn(page: Page, testId: string, timeout: number): Promise<void> {
  await page.waitForFunction((id) => document.activeElement?.getAttribute("data-testid") === id, testId, { timeout });
}

/** Puts focus on the document body so single-key shortcuts apply. */
/**
 * Watches for the next `holder` to appear; the returned read says whether `part` was already in it (no empty box first).
 */
export async function watchWhole(page: Page, holder: string, part: string): Promise<() => Promise<boolean>> {
  await page.evaluate(
    ([holder, part]) => {
      (window as unknown as { __whole: Promise<boolean> }).__whole = new Promise((resolve) => {
        const seen = new MutationObserver(() => {
          const at = document.querySelector(`[data-testid="${holder}"]`);
          if (!at) return;
          seen.disconnect();
          resolve(at.querySelector(`[data-testid="${part}"]`) !== null);
        });
        seen.observe(document.body, { childList: true, subtree: true });
      });
    },
    [holder, part],
  );
  return () => page.evaluate(() => (window as unknown as { __whole: Promise<boolean> }).__whole);
}

export async function focusList(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The search field, opened first where the design keeps it behind a button ("/", as a keyboard user would). */
export async function searchBox(page: Page): Promise<Locator> {
  const input = page.getByTestId("search-input");
  if (!(await input.isVisible())) {
    await focusList(page);
    await page.keyboard.press("/");
    await input.waitFor();
  }
  return input;
}

export async function search(page: Page, query: string): Promise<void> {
  // Lumen keeps search behind a button (plan 15): "/" opens it, as a keyboard user would (a click would change focus-visible for what follows)
  if (!(await page.getByTestId("search-input").isVisible())) {
    await focusList(page);
    await page.keyboard.press("/");
  }
  const input = page.getByTestId("search-input");
  await input.fill(query);
  // the count, said whatever was found (shown when something was, plan 158)
  await expect(page.getByTestId("search-stats")).toHaveCount(1);
}

/** Brings a specific thread to the top of the list via search and selects it. */
export async function selectThread(page: Page, threadId: number, query: string): Promise<void> {
  await search(page, query);
  const row = page.locator(`[data-testid=thread-row][data-thread-id="${threadId}"]`);
  await row.dispatchEvent("mousedown");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await focusList(page);
}

/** Visual tests: hide transient toasts and park the mouse so nothing hovers. */
export async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({ content: "[data-testid=snack-dock]:not(:has([data-testid=category-snackbar])){display:none!important} *{caret-color:transparent!important}" });
  await page.mouse.move(0, 0);
}

/** Goes to a folder from the sidebar, opening More first where it hides (plan 21: only Inbox and Starred are always shown). */
/** Plan 158: a category's own suggestions, from its menu (the sidebar's one Review line opens the category with the most). */
export async function openReview(page: Page, categoryId: number): Promise<void> {
  await page.getByTestId(`nav-category-${categoryId}`).click({ button: "right" });
  await page.getByTestId("category-menu-review").click();
}

/** How many suggestions a category's row holds (0 with none). */
export const suggestedIn = (page: Page, categoryId: number): Promise<number> =>
  page.getByTestId(`nav-category-${categoryId}`).evaluate((el) => Number(el.closest<HTMLElement>("[data-suggested]")?.dataset.suggested ?? 0));

export async function navTo(page: Page, view: "inbox" | "starred" | "sent" | "archive" | "all" | "spam" | "trash"): Promise<void> {
  const item = page.getByTestId(`nav-${view}`);
  if (!(await item.isVisible())) {
    const more = page.getByTestId("nav-more");
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
  }
  await item.click();
}

/**
 * First-run discovery probes Ollama and LM Studio on their default ports. Point both at
 * known places (a stub, or a closed port) so a real server on the test machine can't leak in.
 */
export async function isolateLocalDiscovery(server: DevServer, ollamaUrl?: string): Promise<void> {
  const ctx = { clientId: "setup", origin: "dev" as const };
  await server.backend.server.invoke("settings.update", { ai: { provider: "lmstudio", baseURL: "http://127.0.0.1:9/v1" } }, ctx);
  await server.backend.server.invoke("settings.update", { ai: { provider: "ollama", baseURL: ollamaUrl ? `${ollamaUrl}/v1` : "http://127.0.0.1:9/v1" } }, ctx);
  await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, ctx);
}

/**
 * A conversation built straight into the store (no sync): `count` messages,
 * alternating between Yuki and the account's owner, the first `html` of them
 * with an HTML body. Every message is read (the last `unread` of them
 * aren't), so all but the last start collapsed. `mineFirst`: the owner writes
 * first. Returns the thread id.
 */
export async function ingestConversation(server: DevServer, o: { subject: string; count: number; html?: number; unread?: number; mineFirst?: boolean; now: number }): Promise<number> {
  const db = sqlDb(server.backend.store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const key = o.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const yuki = { name: "Yuki Gutiérrez", email: "yuki.gutierrez@acme.studio" };
  const me = { name: "Luis Cordero", email: acct.email };
  const para = (i: number) => `Mensaje ${i + 1}: revisamos la propuesta, los tiempos y el presupuesto de la campaña. ¿Te parece si lo cerramos esta semana?`;
  const messages: IncomingMessage[] = Array.from({ length: o.count }, (_, i) => {
    const mine = (i + (o.mineFirst ? 1 : 0)) % 2 === 1;
    return {
      accountId: acct.id,
      providerMsgId: `${key}-${i}`,
      providerThreadId: `thread-${key}`,
      rfcMessageId: `<${key}-${i}@e2e.test>`,
      inReplyTo: i ? `<${key}-${i - 1}@e2e.test>` : null,
      references: Array.from({ length: i }, (_, j) => `<${key}-${j}@e2e.test>`),
      from: mine ? me : yuki,
      to: [mine ? yuki : me],
      cc: [],
      bcc: [],
      subject: i ? `Re: ${o.subject}` : o.subject,
      date: o.now - (o.count - i) * 3_600_000,
      snippet: para(i),
      bodyText: `${para(i)}\n\nSaludos.`,
      bodyHtml: i < (o.html ?? 0) ? `<div>${Array.from({ length: 12 }, () => `<p>${para(i)}</p>`).join("")}<table><tr><td>Concepto</td><td>Monto</td></tr></table></div>` : null,
      bodyState: "full",
      listId: null,
      isRead: i < o.count - (o.unread ?? 0),
      isStarred: false,
      inInbox: true,
      isSent: mine,
      isDraft: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      size: 2000,
    };
  });
  await server.backend.store.sync.ingest(messages, { applyFilters: false, now: o.now, classifier: null });
  return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", `${key}-0`)!.thread_id;
}

/** The print fixtures (plan 09), ingested into this test's own backend only. Returns each one's thread id. */
export async function ingestPrintFixtures(server: DevServer): Promise<Record<PrintFixtureKey, number>> {
  const first = await seedPrintFixtures(server.backend.store, { now: E2E_NOW });
  const db = sqlDb(server.backend.store);
  return Object.fromEntries(Object.entries(first).map(([key, msgId]) => [key, db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", msgId)!.thread_id])) as Record<PrintFixtureKey, number>;
}

/** Through a row menu's submenus, as a pointer goes: each named row opens its `-list`. */
export async function menuPath(page: Page, ...triggers: string[]): Promise<void> {
  for (const id of triggers) {
    await page.getByTestId(id).hover();
    await expect(page.getByTestId(`${id}-list`)).toBeVisible();
  }
}

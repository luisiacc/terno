import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { sqlDb, startDevServer, type DevServer } from "../../backend-dev/src/server";
import type { IncomingMessage } from "@terno/store";
import type { DesignId } from "@terno/core";
import { seedPrintFixtures } from "@terno/backend";
import type { PrintFixtureKey } from "@terno/mock-data";
import { E2E_NOW, TEMPLATE_ENV } from "./constants";
import { iconStub, type IconStub } from "./icon-stub";

export { expect };

/** A message the backend handed to SMTP (plan 16: the desktop's real send path into an in-process server). */
export interface CapturedMail {
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
        received.push({ raw: Buffer.concat(chunks).toString("utf8"), rcpt: session.envelope.rcptTo.map((r) => r.address) });
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
}

async function networkRegistry(net: TestNetwork): Promise<import("@terno/mail").ProviderRegistry> {
  const { createDemoProvider, demoRegistry, ProviderError } = await import("@terno/mail");
  return {
    ...demoRegistry,
    create(ctx) {
      const demo = createDemoProvider(ctx, 5);
      return {
        ...demo,
        async sync(sink) {
          if (net.hold) await net.hold;
          if (net.down) throw ProviderError.network("IMAP: connect ECONNREFUSED");
          return demo.sync(sink);
        },
      };
    },
  };
}

interface Fixtures {
  /** freeze Date for deterministic list dates (off for perf: the fake clock coarsens performance.now) */
  fixedClock: boolean;
  /** backend-dev knobs: a fresh install with no mailbox, and owner claims through the demo registry */
  backendOptions: { empty?: boolean; ownerClaims?: boolean; agentSocket?: boolean; smtpCapture?: boolean; network?: boolean };
  /** the design the app opens in (plan 15): each Playwright project sets its own; null leaves the install's default (Lumen) */
  design: DesignId | null;
  /** plan 24: the layout the app opens in (null: the install's default, Split) */
  layout: "split" | "list" | null;
  server: DevServer & { smtp: CapturedMail[]; net: TestNetwork; icons: IconStub };
  /** the app, loaded, connected and showing the inbox */
  app: Page;
}

export const test = base.extend<Fixtures>({
  fixedClock: [true, { option: true }],
  backendOptions: [{}, { option: true }],
  design: ["macos", { option: true }],
  layout: [null, { option: true }],
  server: async ({ backendOptions }, use) => {
    const template = process.env[TEMPLATE_ENV];
    if (!template) throw new Error("global setup did not seed a template database");
    const dir = mkdtempSync(join(tmpdir(), "terno-e2e-"));
    if (!backendOptions.empty) {
      copyFileSync(template, join(dir, "terno.db"));
      // the template's search snapshot too (written on close), so each backend restores instead of building
      if (existsSync(`${template}.search`)) copyFileSync(`${template}.search`, join(dir, "terno.db.search"));
    }
    const capture = backendOptions.smtpCapture ? await smtpRegistry() : null;
    const net: TestNetwork = { down: false, hold: null };
    const providers = backendOptions.network ? await networkRegistry(net) : capture?.registry;
    // plan 20: the retry after a first failure comes in a second, then a minute (time enough to look)
    const connectivity = backendOptions.network ? { delays: [1000, 60_000] } : undefined;
    // plan 22: website icons never reach the internet from a test (a few seeded sites have icons, the rest 404)
    const icons = iconStub();
    const server = await startDevServer({ port: 0, dataDir: dir, token: "e2e", now: () => E2E_NOW, autoSync: true, seed: !backendOptions.empty, ownerClaims: backendOptions.ownerClaims, agentSocket: backendOptions.agentSocket, providers, connectivity, iconTransport: icons });
    await use(Object.assign(server, { smtp: capture?.received ?? [], net, icons }));
    // Backend.stop() doesn't wait for an in-flight ops batch; let it settle first.
    const b = server.backend as unknown as { workerRunning: boolean };
    for (let i = 0; i < 100 && b.workerRunning; i++) await new Promise((r) => setTimeout(r, 20));
    await server.close();
    await capture?.close();
    rmSync(dir, { recursive: true, force: true });
  },
  app: async ({ page, server, fixedClock, backendOptions, design, layout }, use) => {
    if (fixedClock) await page.clock.setFixedTime(new Date(E2E_NOW));
    if (design) await server.backend.server.invoke("settings.update", { design }, { clientId: "setup", origin: "dev" as const });
    if (layout) await server.backend.server.invoke("settings.update", { layout }, { clientId: "setup", origin: "dev" as const });
    await page.goto(`/?backend=${encodeURIComponent(server.url)}&token=e2e`);
    await page.locator("[data-ready]").waitFor();
    if (!backendOptions.empty) await rows(page).first().waitFor();
    await use(page);
  },
});

export const rows = (page: Page): Locator => page.getByTestId("thread-row");
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

/** Puts focus on the document body so single-key shortcuts apply. */
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
  await expect(page.getByTestId("search-stats")).toBeVisible();
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
 * aren't), so all but the last start collapsed. Returns the thread id.
 */
export async function ingestConversation(server: DevServer, o: { subject: string; count: number; html?: number; unread?: number; now: number }): Promise<number> {
  const db = sqlDb(server.backend.store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const key = o.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const yuki = { name: "Yuki Gutiérrez", email: "yuki.gutierrez@acme.studio" };
  const me = { name: "Luis Cordero", email: acct.email };
  const para = (i: number) => `Mensaje ${i + 1}: revisamos la propuesta, los tiempos y el presupuesto de la campaña. ¿Te parece si lo cerramos esta semana?`;
  const messages: IncomingMessage[] = Array.from({ length: o.count }, (_, i) => {
    const mine = i % 2 === 1;
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

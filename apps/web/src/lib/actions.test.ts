/**
 * What the triage snacks say: one sentence per count (plural rules of the
 * active language), with the undo's accessible name in the same language.
 * Node, with the RPC client mocked and a minimal fake <html>.
 */
import type { ThreadSummary } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => fake.handlers[method]?.(params) ?? Promise.resolve({}),
    on: () => () => {},
  },
}));

const { act, said } = await import("./actions");
const { getApp, navigate, setAccounts, setApp } = await import("~/state/app");
const { useList } = await import("~/state/list");
const { resetSnacks, useSnack } = await import("~/lib/snack");

const row = (id: number): ThreadSummary => ({ id, unread: false, starred: false, categoryIds: [] }) as unknown as ThreadSummary;

beforeEach(() => {
  fake.handlers = {};
  resetSnacks();
  const items = [row(1), row(2), row(3)];
  useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  setApp({ view: "inbox", query: "", selectedId: null, checked: new Set(), scope: null });
});
afterEach(() => setLocale("en", en));

describe("action snacks", () => {
  it("one conversation says what happened; several add the count", () => {
    expect(said("archive", 1)).toBe("Archived");
    expect(said("archive", 3)).toBe("Archived · 3 conversations");
    expect(said("notSpam", 1234)).toBe("Moved to Inbox · 1,234 conversations");
    setLocale("es", es);
    expect(said("archive", 1)).toBe("Archivado");
    expect(said("trash", 2)).toBe("Movido a la papelera · 2 conversaciones");
  });

  it("the snack and its undo's accessible name follow the language", async () => {
    setLocale("es", es);
    fake.handlers["threads.act"] = async () => ({ undoId: 9 });
    await act("archive", [1, 2]);
    const s = useSnack.getState().current;
    expect(s?.message).toBe("Archivado · 2 conversaciones");
    expect(s?.action?.label).toBe("Deshacer");
    expect(s?.action?.name).toBe("Deshacer archivar");
  });

  it("a failure says it couldn't complete, with the reason", async () => {
    fake.handlers["threads.act"] = async () => {
      throw new Error("offline");
    };
    await act("archive", [1]);
    expect(useSnack.getState().current?.message).toBe("Couldn’t complete: offline");
  });
});

describe("a search's selection spanning places (plan 64)", () => {
  const placed = (id: number, inInbox: boolean, inSpam = false, inTrash = false) => ({ ...row(id), inInbox, inSpam, inTrash }) as ThreadSummary;
  const sent: { action: string; threadIds: number[] }[] = [];
  beforeEach(() => {
    sent.length = 0;
    fake.handlers["threads.act"] = async (p) => {
      sent.push(p as { action: string; threadIds: number[] });
      return { undoId: 1 };
    };
    const items = [placed(1, true), placed(2, false, false, true), placed(3, false, true), placed(4, true)];
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  });

  it("a key on the selection acts on the rows it fits, as the buttons do (! never spams the trashed one)", async () => {
    setApp({ query: "factura", checked: new Set([1, 2]) });
    await act("spam");
    // acting clears the selection: the same two again
    setApp({ checked: new Set([1, 2]) });
    await act("moveToInbox");
    expect(sent).toEqual([
      { action: "spam", threadIds: [1] },
      { action: "moveToInbox", threadIds: [2] },
    ]);
  });

  it("it reads the selection when it runs: a same-size selection made since is the one acted on", async () => {
    setApp({ query: "factura", checked: new Set([1, 2]) });
    setApp({ checked: new Set([3, 4]) });
    await act("trash");
    expect(sent).toEqual([{ action: "trash", threadIds: [3, 4] }]);
  });

  it("outside a search, the view's rule: every selected row", async () => {
    setApp({ query: "", checked: new Set([1, 2]) });
    await act("spam");
    expect(sent).toEqual([{ action: "spam", threadIds: [1, 2] }]);
  });
});

describe("Gmail's Promotions and Social (plan 86)", () => {
  const account = (id: number, kind: "gmail" | "imap", separateTabs = true) => ({ id, kind, email: `${id}@x.test`, displayName: `A${id}`, color: "indigo", senderName: "", signature: "", syncWindowDays: null, separateTabs, syncState: { status: "idle", syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null } }) as never;
  const tabbed = (id: number, accountId: number, tab: number) => ({ ...row(id), accountId, inInbox: true, inSpam: false, inTrash: false, tab }) as ThreadSummary;
  const sent: { action: string; threadIds: number[] }[] = [];
  beforeEach(() => {
    sent.length = 0;
    fake.handlers["threads.act"] = async (p) => {
      sent.push(p as { action: string; threadIds: number[] });
      return { undoId: 1 };
    };
    setApp({ accounts: [account(1, "gmail"), account(2, "imap")], gmailTab: null, accountId: null, folder: null, categoryId: null, reviewCategoryId: null });
    const items = [tabbed(1, 1, 1), tabbed(2, 1, 0), tabbed(3, 2, 0)];
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  });

  it("Move to Inbox on rows in a tab takes them out of it (Gmail learns); the rest move as before", async () => {
    await act("moveToInbox", [1, 2, 3]);
    expect(sent).toEqual([
      { action: "toPrimary", threadIds: [1] },
      { action: "moveToInbox", threadIds: [2, 3] },
    ]);
    expect(useSnack.getState().current?.message).toBe("Moved to Inbox · 2 conversations");
  });

  it("a row in a tab its account shows in the Inbox (the setting off) moves as before", async () => {
    setApp({ accounts: [account(1, "gmail", false), account(2, "imap")] });
    await act("moveToInbox", [1]);
    expect(sent).toEqual([{ action: "moveToInbox", threadIds: [1] }]);
  });

  it("in Promotions, Move to Promotions keeps the row and Move to Inbox takes it away; in the Inbox, Move to Promotions does", async () => {
    navigate({ accountId: 1, gmailTab: "promotions" });
    expect(getApp()).toMatchObject({ view: "inbox", accountId: 1, gmailTab: "promotions", folder: null, categoryId: null });
    const items = [tabbed(1, 1, 1), tabbed(4, 1, 1)];
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
    await act("toPromotions", [1]);
    expect(useList.getState().items.map((t) => t.id)).toEqual([1, 4]);
    await act("moveToInbox", [1]);
    expect(useList.getState().items.map((t) => t.id)).toEqual([4]);
    navigate({ view: "inbox", accountId: 1 });
    const inbox = [tabbed(5, 1, 0)];
    useList.setState({ items: inbox, index: new Map(inbox.map((t, i) => [t.id, i])) });
    await act("toSocial", [5]);
    expect(useList.getState().items).toEqual([]);
    expect(sent.map((s) => s.action)).toEqual(["toPromotions", "toPrimary", "toSocial"]);
  });

  it("a tab is its account's Inbox, alone: anywhere else leaves it; an account that stops separating sends you to its Inbox", () => {
    navigate({ accountId: 1, gmailTab: "social" });
    setApp({ categoryId: 7 });
    expect(getApp().gmailTab).toBeNull();
    navigate({ accountId: 1, gmailTab: "social" });
    setApp({ scope: { key: "k", scope: { kind: "view", view: "inbox", accountId: 1, tab: "social" }, label: "Social", count: 3 } });
    setAccounts([account(1, "gmail", false), account(2, "imap")]);
    expect(getApp()).toMatchObject({ view: "inbox", accountId: 1, gmailTab: null, scope: null });
  });
});

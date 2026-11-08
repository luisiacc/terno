// @vitest-environment jsdom
/**
 * What the triage snacks say: one sentence per count (plural rules of the
 * active language), with the undo's accessible name in the same language.
 * With the RPC client mocked.
 */
import type { ThreadSummary } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
  g.document ??= { activeElement: null, querySelector: () => null };
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
const { resetSnacks, runUndo, undoLast, useSnack } = await import("~/lib/snack");

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

  it("plan 158: one star says nothing, unless asked to where nothing else shows it", async () => {
    fake.handlers["threads.act"] = async () => ({ undoId: 9 });
    await act("star", [1]);
    expect(useSnack.getState().current).toBeNull();
    await act("star", [1], { announce: true });
    expect(useSnack.getState().current?.message).toBe("Starred");
  });

  it("a failure says it couldn't complete, with the reason", async () => {
    fake.handlers["threads.act"] = async () => {
      throw new Error("offline");
    };
    await act("archive", [1]);
    expect(useSnack.getState().current?.message).toBe("Couldn’t complete: offline");
  });
});

describe("Undo puts the selection back (plan 158)", () => {
  const acted = () => {
    fake.handlers["threads.act"] = async () => ({ undoId: 9 });
    fake.handlers["threads.undo"] = async () => ({ restored: 2 });
    fake.handlers["threads.list"] = vi.fn(async () => ({ items: [row(1), row(2), row(3)], nextCursor: null }));
  };
  const undo = () => runUndo(useSnack.getState().undo!);

  it("what was checked, and the row that was open", async () => {
    acted();
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    expect(getApp().checked.size).toBe(0);
    expect(getApp().selectedId).toBe(3);
    await undo();
    await vi.waitFor(() => expect([...getApp().checked]).toEqual([1, 2]));
    expect(getApp().selectedId).toBe(1);
  });

  it("never over a selection made since, nor when the open row has moved on", async () => {
    acted();
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    setApp({ selectedId: 2, checked: new Set([3]) });
    await undo();
    await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r));
    expect([...getApp().checked]).toEqual([3]);
    expect(getApp().selectedId).toBe(2);
  });

  it("nor after opening another row: the next action would hit the old batch", async () => {
    acted();
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    setApp({ selectedId: 3 });
    fake.handlers["threads.list"] = vi.fn(async () => ({ items: [row(1), row(2), row(3), row(4)], nextCursor: null }));
    setApp({ selectedId: 4 });
    await undo();
    await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r));
    expect(getApp().checked.size).toBe(0);
    expect(getApp().selectedId).toBe(4);
  });

  it("says it worked: a restore by how many came back, a mark by Undone", async () => {
    acted();
    await act("archive", [1, 2]);
    await undo();
    expect(useSnack.getState().current?.message).toBe("Restored 2 conversations");
    await act("star", [1, 2]);
    await undo();
    expect(useSnack.getState().current?.message).toBe("Undone · 2 conversations");
  });

  it("a late Restored never pushes aside a later action's Undo", async () => {
    acted();
    let release!: () => void;
    fake.handlers["threads.undo"] = () => new Promise((r) => (release = () => r({ restored: 1 })));
    await act("archive", [1]);
    const undoing = undo();
    await act("trash", [2]);
    expect(useSnack.getState().current?.message).toBe("Moved to Trash");
    release();
    await undoing;
    expect(useSnack.getState().current?.message).toBe("Moved to Trash");
    expect(useSnack.getState().current?.action).toBeDefined();
  });

  it("nor one asked for before its action had answered", async () => {
    acted();
    let answer!: () => void;
    fake.handlers["threads.act"] = () => new Promise((r) => (answer = () => r({ undoId: 9 })));
    const archiving = act("archive", [1]);
    const undoing = undo();
    fake.handlers["threads.act"] = async () => ({ undoId: 10 });
    await act("trash", [2]);
    expect(useSnack.getState().current?.message).toBe("Moved to Trash");
    answer();
    await archiving;
    await undoing;
    expect(useSnack.getState().current?.message).toBe("Moved to Trash");
  });

  it("nor after opening another row and coming back to the same one while it's on its way (series review)", async () => {
    acted();
    let release: (() => void) | undefined;
    fake.handlers["threads.undo"] = () => new Promise((r) => (release = () => r({ restored: 2 })));
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    expect(getApp().selectedId).toBe(3);
    const undoing = undo();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    setApp({ selectedId: 4 });
    setApp({ selectedId: 3 });
    release!();
    await undoing;
    await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r));
    expect(getApp().checked.size).toBe(0);
    expect(getApp().selectedId).toBe(3);
  });

  it("nor after a check made and taken off again (series review)", async () => {
    acted();
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    setApp({ checked: new Set([3]) });
    setApp({ checked: new Set() });
    await undo();
    await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r));
    expect(getApp().checked.size).toBe(0);
  });

  it("the keyboard goes back to the list, but never from a recipient chip or anywhere focus went since Undo was asked (series review)", async () => {
    document.body.innerHTML = `<div data-testid="thread-list"><div data-keep-scroll="list" tabindex="0"></div></div><button data-testid="other">x</button><div data-draft-key="k"><div data-recipient-field="compose-to"><span role="option" tabindex="-1" data-testid="chip">ana@example.com</span></div></div>`;
    const list = document.querySelector<HTMLElement>("[data-keep-scroll=list]")!, chip = document.querySelector<HTMLElement>("[data-testid=chip]")!, other = document.querySelector<HTMLElement>("[data-testid=other]")!;
    try {
      const archiveWhile = async (meanwhile: () => void) => {
        acted();
        let release: (() => void) | undefined;
        fake.handlers["threads.undo"] = () => new Promise((r) => (release = () => r({ restored: 2 })));
        setApp({ selectedId: 1, checked: new Set([1, 2]) });
        await act("archive");
        const undoing = undo();
        await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        meanwhile();
        release!();
        await undoing;
        await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r));
      };
      // as it was: from nowhere, back to the list
      (document.activeElement as HTMLElement | null)?.blur();
      await archiveWhile(() => {});
      expect(document.activeElement).toBe(list);
      // a chip focused meanwhile keeps the keyboard (an `e` there would archive mail)
      await archiveWhile(() => chip.focus());
      expect([...getApp().checked]).toEqual([1, 2]);
      expect(document.activeElement).toBe(chip);
      // focus anywhere else since is the user's too
      await archiveWhile(() => other.focus());
      expect(document.activeElement).toBe(other);
      // a refused restore moves nothing
      other.blur();
      await archiveWhile(() => setApp({ selectedId: 2 }));
      expect(document.activeElement).toBe(document.body);
    } finally {
      document.body.innerHTML = "";
    }
  });

  it("not in another list", async () => {
    acted();
    setApp({ selectedId: 1, checked: new Set([1, 2]) });
    await act("archive");
    setApp({ view: "sent" });
    await undo();
    await vi.waitFor(() => expect(fake.handlers["threads.list"]).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r));
    expect(getApp().checked.size).toBe(0);
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

  it("Move to Inbox on a mix of rows in a tab and others is one action, one snack and one Undo (the backend takes them out of the tab)", async () => {
    const undone: number[] = [];
    fake.handlers["threads.undo"] = async (p) => (undone.push((p as { undoId: number }).undoId), { restored: 3 });
    await act("moveToInbox", [1, 2, 3]);
    expect(sent).toEqual([{ action: "moveToInbox", threadIds: [1, 2, 3] }]);
    expect(useSnack.getState().current?.message).toBe("Moved to Inbox · 3 conversations");
    await undoLast();
    await vi.waitFor(() => expect(undone).toEqual([1]));
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
    expect(sent.map((s) => s.action)).toEqual(["toPromotions", "moveToInbox", "toSocial"]);
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

describe("an account's Mark all as read (plan 106)", () => {
  const unread = (id: number, accountId: number, tab = 0) => ({ ...row(id), unread: true, accountId, tab, inInbox: true }) as ThreadSummary;
  const gmail = { id: 1, kind: "gmail", email: "a@gmail.com", displayName: "A", color: "indigo", syncState: { status: "idle" } };
  const imap = { id: 2, kind: "imap", email: "b@example.com", displayName: "B", color: "rose", syncState: { status: "idle" } };
  let answer: (v: unknown) => void = () => {};
  beforeEach(() => {
    setAccounts([gmail, imap] as never);
    fake.handlers["threads.actScope"] = () => new Promise((r) => (answer = r));
    // 12: a promotion of the Gmail account, on top of the Inbox for its reminder; it isn't in the account's Inbox
    const items = [unread(10, 1), unread(11, 1), unread(12, 1, 1), unread(20, 2)];
    useList.setState({ items, index: new Map(items.map((t, i) => [t.id, i])) });
  });
  afterEach(() => {
    answer({ undoId: null, affected: 0, total: 0 });
    setApp({ listFilters: new Map() });
  });
  const shown = () => useList.getState().items.map((t) => [t.id, t.unread]);
  /** the rows on screen are the current list's */
  const loaded = async () => useList.setState({ itemsKey: (await import("~/state/list")).listKey() });

  it("under the Unread filter, the account's rows go but the checked one stays checked and is read in place (Codex code review #2)", async () => {
    setApp({ view: "inbox", accountId: null, categoryId: null, folder: null, gmailTab: null, reminders: false, listFilters: new Map([["inbox||", "unread"]]), checked: new Set([10, 20]), selectedId: null });
    await loaded();
    const { markAccountRead } = await import("./actions");
    void markAccountRead(1, 2);
    expect(shown()).toEqual([[10, false], [12, true], [20, true]]);
    expect([...getApp().checked]).toEqual([10, 20]);
  });

  it("a row in a Gmail tab the account keeps apart is left as it is (Codex code review #4)", async () => {
    setApp({ view: "inbox", accountId: null, categoryId: null, folder: null, gmailTab: null, reminders: false, listFilters: new Map(), checked: new Set(), selectedId: null });
    await loaded();
    const { markAccountRead } = await import("./actions");
    void markAccountRead(1, 2);
    expect(shown()).toEqual([[10, false], [11, false], [12, true], [20, true]]);
  });

  it("the Inbox still loading over the previous view's rows: those rows aren't touched (Codex code review round 2 #3)", async () => {
    setApp({ view: "archive", accountId: null, categoryId: null, folder: null, gmailTab: null, reminders: false, listFilters: new Map(), checked: new Set(), selectedId: null });
    await loaded();
    setApp({ view: "inbox" });
    const { markAccountRead } = await import("./actions");
    void markAccountRead(1, 2);
    expect(shown()).toEqual([[10, true], [11, true], [12, true], [20, true]]);
  });

  it("outside an Inbox listing, nothing shown changes until the reload", async () => {
    setApp({ view: "archive", accountId: null, categoryId: null, folder: null, gmailTab: null, reminders: false, listFilters: new Map(), checked: new Set(), selectedId: null });
    const { markAccountRead } = await import("./actions");
    void markAccountRead(1, 2);
    expect(shown()).toEqual([[10, true], [11, true], [12, true], [20, true]]);
  });
});

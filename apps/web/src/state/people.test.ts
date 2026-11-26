// @vitest-environment jsdom
/** Plan 281: People's rows, the search's marks, an item's words, the view's place among the own lists, and an act's page. */
import { personKey, type PeopleList, type PersonItem, type PersonOpen, type PersonPage, type ThreadSummary } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
const call = vi.fn();
vi.mock("~/rpc/connection", () => ({ client: { call: (...a: unknown[]) => call(...a), on: () => () => {}, onAttach: () => () => {} } }));

const { matchedParts, peopleRows, usePeople } = await import("~/state/people");
const { getApp, navigate, ownList, setApp } = await import("~/state/app");
const { withoutItem, withoutListItem, actOnPersonItem, movePerson, selectPerson } = await import("~/lib/people");
const { closePage } = await import("~/lib/page");
const { useAppearance } = await import("~/lib/appearance");
const { itemParts } = await import("~/components/people/person-item");

const thread = (id: number, subject: string, fromName = "Ana Ruiz", fromEmail = "ana@x.test") => ({ id, accountId: 1, subject, fromName, fromEmail, lastDate: 0 }) as ThreadSummary;
const waiting = (id: number, subject: string): PersonItem => ({ kind: "today", item: { id: `waiting:${id}`, thread: thread(id, subject), why: { kind: "waiting", reply: { since: 1, rev: 0, message: id } } } });
const owed = (id: number, text: string): PersonItem => ({ kind: "awaiting", row: { id, threadId: id, kind: "awaiting", text, personName: "Ana Ruiz", personEmail: "ana@x.test", sentAt: 0, dueAt: 0, revision: 0 } as never, thread: thread(id, "Contract") });
const open = (key: string, name: string, items: PersonItem[]): PersonOpen => ({ key, email: key, name, items });

afterEach(() => {
  call.mockReset();
  usePeople.setState({ list: null, query: "", hits: null, page: null, reading: null, failed: false, pageFailed: null });
});

describe("the list's rows", () => {
  const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", [waiting(1, "Phase 2"), owed(2, "the contract")])], everyone: [{ name: "Marco Bell", email: "Marco@x.test", last: 5, written: true }], index: "ready" };

  it("Open, then Everyone, each under its heading with its count", () => {
    const rows = peopleRows(list, "", null, personKey);
    expect(rows.map((r) => (r.kind === "heading" ? `#${r.id}:${r.count}` : r.key))).toEqual(["#open:1", "ana@x.test", "#everyone:1", "marco@x.test"]);
    expect(rows[1]).toMatchObject({ openCount: 2 });
  });

  it("a heading only over rows; nothing before the first answer", () => {
    expect(peopleRows(null, "", null, personKey)).toEqual([]);
    expect(peopleRows({ ...list, open: [] }, "", null, personKey).map((r) => r.id)).toEqual(["everyone", "marco@x.test"]);
  });

  it("while something's typed, the hits alone (their address and how many open), none until they answer", () => {
    expect(peopleRows(list, "an", null, personKey)).toEqual([]);
    const rows = peopleRows(list, "an", { hits: [{ name: "Ana Ruiz", email: "ana@x.test", key: "ana@x.test", last: 1, written: true, open: 2 }], index: "ready" }, personKey);
    expect(rows).toEqual([{ kind: "person", id: "ana@x.test", key: "ana@x.test", email: "ana@x.test", name: "Ana Ruiz", last: 1, open: null, openCount: 2 }]);
  });
});

describe("what a search matched", () => {
  it("each word at a word's start, accents and case aside", () => {
    expect(matchedParts("Andrés López", "lop")).toEqual([{ text: "Andrés ", hit: false }, { text: "Lóp", hit: true }, { text: "ez", hit: false }]);
    expect(matchedParts("ana@greenway.studio", "greenway")).toEqual([{ text: "ana@", hit: false }, { text: "greenway", hit: true }, { text: ".studio", hit: false }]);
    expect(matchedParts("Ana Ruiz", "an ru")?.filter((p) => p.hit).map((p) => p.text)).toEqual(["An", "Ru"]);
  });

  it("nothing marked inside a word, or for nothing typed", () => {
    expect(matchedParts("Diana", "an")).toBeNull();
    expect(matchedParts("Ana", "  ")).toBeNull();
  });
});

describe("an item in a few words", () => {
  it("its kind and what, never naming the person again", () => {
    expect(itemParts(waiting(1, "Phase 2"))).toEqual({ label: "Waiting on you", text: "Phase 2" });
    expect(itemParts(owed(2, "the signed contract"))).toEqual({ label: "Owes you a reply", text: "The signed contract" });
    const promise: PersonItem = { kind: "today", item: { id: "promise:3", thread: thread(3, "SOW"), why: { kind: "promise", text: "send the revised SOW", personEmail: "ana@x.test" } } };
    expect(itemParts(promise)).toEqual({ label: "You promised", text: "Send the revised SOW" });
  });
});

describe("People among the own lists", () => {
  it("navigate turns the others off, and another list (a search, a mailbox) leaves People and its person", () => {
    navigate({ today: true });
    navigate({ people: true });
    expect(getApp()).toMatchObject({ people: true, today: false, view: "all", accountId: null });
    expect(ownList(getApp())).toBe(true);
    setApp({ person: "ana@x.test" });
    setApp({ query: "invoice" });
    expect(getApp()).toMatchObject({ people: false, person: null });
    navigate({ people: true });
    setApp({ person: "ana@x.test" });
    navigate({ view: "inbox" });
    expect(getApp()).toMatchObject({ people: false, person: null, view: "inbox" });
  });
});

describe("acting on a person's page", () => {
  const page: PersonPage = { key: "ana@x.test", email: "ana@x.test", name: "Ana Ruiz", items: [waiting(1, "Phase 2"), owed(2, "the contract")], conversations: [], more: false };

  it("Done takes the item off the page and the person's row at once; a failure reads both again (never an old copy back)", async () => {
    navigate({ people: true });
    setApp({ person: "ana@x.test" });
    const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", page.items)], everyone: [], index: "ready" };
    usePeople.setState({ page, list });
    let fail!: (e: Error) => void;
    call.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const acting = actOnPersonItem(page.items[0]!, "done");
    expect(call).toHaveBeenCalledWith("today.waitingAct", expect.objectContaining({ threadId: 1, action: "done" }));
    expect(usePeople.getState().page?.items).toHaveLength(1);
    expect(usePeople.getState().list?.open[0]?.items).toHaveLength(1);
    call.mockResolvedValue(null);
    fail(new Error("offline"));
    await acting;
    // the truth again: the list and the page asked for, nothing restored from before
    expect(call).toHaveBeenCalledWith("people.list", {});
    expect(call).toHaveBeenCalledWith("people.person", { email: "ana@x.test" });
    expect(withoutItem(page, "waiting:1").items.map((i) => (i.kind === "awaiting" ? i.row.id : 0))).toEqual([2]);
  });

  it("their last item done: the row leaves Open and falls into its place in Everyone", () => {
    const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", [waiting(1, "Phase 2")])], everyone: [{ name: "Bea", email: "bea@x.test", last: 0, written: true }, { name: "Ana Ruiz", email: "ana@x.test", last: 0, written: true }], index: "ready" };
    expect(peopleRows(list, "", null, personKey).map((r) => r.id)).toEqual(["open", "ana@x.test", "everyone", "bea@x.test"]);
    expect(peopleRows(withoutListItem(list, "waiting:1"), "", null, personKey).map((r) => r.id)).toEqual(["everyone", "bea@x.test", "ana@x.test"]);
  });

  it("a page read for someone no longer selected never lands, even late in a morph", async () => {
    navigate({ people: true });
    let answerA!: (p: PersonPage) => void;
    call.mockImplementationOnce(() => new Promise((r) => (answerA = r)));
    selectPerson("a@x.test", "a@x.test");
    call.mockResolvedValueOnce({ ...page, key: "b@x.test", email: "b@x.test", name: "B" });
    selectPerson("b@x.test", "b@x.test");
    await vi.waitFor(() => expect(usePeople.getState().page?.key).toBe("b@x.test"));
    answerA({ ...page, key: "a@x.test", email: "a@x.test" });
    await Promise.resolve();
    expect(usePeople.getState().page?.key).toBe("b@x.test");
  });

  it("List: Back from a conversation opened on a person's page leaves none selected behind it", () => {
    useAppearance.setState({ layout: "list" });
    try {
      navigate({ people: true });
      setApp({ person: "ana@x.test", selectedId: 7, readerOpen: true });
      closePage();
      expect(getApp()).toMatchObject({ person: "ana@x.test", selectedId: null, readerOpen: false });
    } finally {
      useAppearance.setState({ layout: "split" });
    }
  });

  it("Later keeps the item where it is (it's still open): the answer moves it", async () => {
    navigate({ people: true });
    setApp({ person: "ana@x.test" });
    usePeople.setState({ page });
    call.mockResolvedValueOnce({ undoId: "u1" });
    await actOnPersonItem(page.items[1]!, "later", Date.now() + 86_400_000);
    expect(call).toHaveBeenCalledWith("followups.act", expect.objectContaining({ id: 2, action: "later" }));
    expect(usePeople.getState().page?.items).toHaveLength(2);
  });
});

describe("j and k", () => {
  it("walk the people (headings skipped), each one's page with them, from the selected one", () => {
    navigate({ people: true });
    call.mockResolvedValue(null);
    usePeople.setState({ list: { open: [open("a@x.test", "A", [waiting(1, "One")])], everyone: [{ name: "B", email: "b@x.test", last: 0, written: true }, { name: "C", email: "c@x.test", last: 0, written: true }], index: "ready" } });
    movePerson(1);
    expect(getApp().person).toBe("a@x.test");
    movePerson(1);
    expect(getApp().person).toBe("b@x.test");
    movePerson(5);
    expect(getApp().person).toBe("c@x.test");
    movePerson(-1);
    expect(getApp().person).toBe("b@x.test");
    expect(call).toHaveBeenLastCalledWith("people.person", { email: "b@x.test" });
    selectPerson("b@x.test", "b@x.test");
    expect(getApp().person).toBe("b@x.test");
  });
});

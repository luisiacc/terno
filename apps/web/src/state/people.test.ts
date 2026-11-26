// @vitest-environment jsdom
/** Plan 281: People's rows, the search's marks, an item's words, the view's place among the own lists, and an act's page. */
import { type PeopleList, type PersonItem, type PersonOpen, type PersonPage, type ThreadSummary } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
const call = vi.fn();
vi.mock("~/rpc/connection", () => ({ client: { call: (...a: unknown[]) => call(...a), on: () => () => {}, onAttach: () => () => {} } }));

const { matchedParts, peopleRows, usePeople } = await import("~/state/people");
const { getApp, navigate, ownList, setApp } = await import("~/state/app");
const { withoutItem, withoutListItem, actOnPersonItem, movePerson, selectPerson, searchPeople, enterSearch, installPeople } = await import("~/lib/people");
installPeople();
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
  const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", [waiting(1, "Phase 2"), owed(2, "the contract")])], everyone: [{ name: "Marco Bell", email: "Marco@x.test", key: "marco@x.test", last: 5, written: true }], everyoneVersion: 1, index: "ready" };

  it("Open, then Everyone, each under its heading with its count", () => {
    const rows = peopleRows(list, "", null);
    expect(rows.map((r) => (r.kind === "heading" ? `#${r.id}:${r.count}` : r.key))).toEqual(["#open:1", "ana@x.test", "#everyone:1", "marco@x.test"]);
    expect(rows[1]).toMatchObject({ openCount: 2 });
  });

  it("a heading only over rows; nothing before the first answer", () => {
    expect(peopleRows(null, "", null)).toEqual([]);
    expect(peopleRows({ ...list, open: [] }, "", null).map((r) => r.id)).toEqual(["everyone", "marco@x.test"]);
  });

  it("while something's typed, the hits alone, each read as its row in the list (what's open with them), none until they answer", () => {
    expect(peopleRows(list, "an", null)).toEqual([]);
    const hits = [
      { name: "Ana Ruiz", email: "ana@x.test", key: "ana@x.test", last: 1, written: true, open: 2 },
      { name: "Marco Bell", email: "Marco@x.test", key: "marco@x.test", last: 5, written: true, open: 0 },
    ];
    const rows = peopleRows(list, "a", { hits, index: "ready" });
    expect(rows).toEqual([
      { kind: "person", id: "ana@x.test", key: "ana@x.test", email: "ana@x.test", name: "Ana Ruiz", last: 1, open: list.open[0], openCount: 2 },
      { kind: "person", id: "marco@x.test", key: "marco@x.test", email: "Marco@x.test", name: "Marco Bell", last: 5, open: null, openCount: 0 },
    ]);
  });
});

describe("the person being worked on", () => {
  it("keeps their row where it was in Open; with nothing open any more, it stays there saying so, until another is chosen", () => {
    const base: PeopleList = { open: [open("a@x.test", "A", [waiting(1, "One")]), open("ana@x.test", "Ana Ruiz", [waiting(2, "Two")]), open("c@x.test", "C", [waiting(3, "Three")])], everyone: [{ name: "Ana Ruiz", email: "ana@x.test", key: "ana@x.test", last: 0, written: true }], everyoneVersion: 1, index: "ready" };
    const held = { key: "ana@x.test", index: 1 };
    // the list put her last (an act changed her place): she stays second
    const moved = { ...base, open: [base.open[0]!, base.open[2]!, base.open[1]!] };
    expect(peopleRows(moved, "", null, held).filter((r) => r.kind === "person").map((r) => r.id)).toEqual(["a@x.test", "ana@x.test", "c@x.test"]);
    // her last item done: still second, nothing open, and not in Everyone twice
    const done = { ...base, open: [base.open[0]!, base.open[2]!] };
    const rows = peopleRows(done, "", null, held);
    expect(rows.filter((r) => r.kind === "person").map((r) => r.id)).toEqual(["a@x.test", "ana@x.test", "c@x.test"]);
    expect(rows.find((r) => r.id === "ana@x.test")).toMatchObject({ openCount: 0, open: { items: [] } });
    expect(rows.find((r) => r.kind === "heading" && r.id === "open")).toMatchObject({ count: 2 });
    // let go: she goes where the list puts her (Everyone)
    expect(peopleRows(done, "", null, null).map((r) => r.id)).toEqual(["open", "a@x.test", "c@x.test", "everyone", "ana@x.test"]);
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
    // the person chosen is kept for when People is back
    expect(getApp()).toMatchObject({ people: false, person: "ana@x.test" });
    navigate({ people: true });
    expect(getApp()).toMatchObject({ people: true, person: "ana@x.test" });
    navigate({ view: "inbox" });
    expect(getApp()).toMatchObject({ people: false, view: "inbox" });
  });
});

describe("acting on a person's page", () => {
  const page: PersonPage = { key: "ana@x.test", email: "ana@x.test", name: "Ana Ruiz", items: [waiting(1, "Phase 2"), owed(2, "the contract")], conversations: [], more: false };

  it("Done takes the item off the page and the person's row at once; then the list and the page as they now are, together", async () => {
    navigate({ people: true });
    setApp({ person: "ana@x.test" });
    const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", page.items)], everyone: [], everyoneVersion: 1, index: "ready" };
    usePeople.setState({ page, list });
    let answer!: (r: unknown) => void;
    call.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const acting = actOnPersonItem(page.items[0]!, "done");
    expect(call).toHaveBeenCalledWith("today.waitingAct", expect.objectContaining({ threadId: 1, action: "done" }));
    expect(usePeople.getState().page?.items).toHaveLength(1);
    expect(usePeople.getState().list?.open[0]?.items).toHaveLength(1);
    // a read that was already on its way (the page with the item still in it) doesn't bring it back
    usePeople.setState({ page: withoutItem(page, "nothing") });
    expect(usePeople.getState().page?.items).toHaveLength(2);
    const settled = { ...list, open: [open("ana@x.test", "Ana Ruiz", [page.items[1]!])] };
    call.mockImplementation((method: string) => Promise.resolve(method === "people.list" ? settled : method === "people.person" ? { ...page, items: [page.items[1]!] } : null));
    answer({ undoId: "u1" });
    await acting;
    // the settled read: the list (Everyone not sent again) and the page, landing together
    expect(call).toHaveBeenCalledWith("people.list", { known: 1 });
    expect(call).toHaveBeenCalledWith("people.person", { email: "ana@x.test" });
    expect(usePeople.getState().page?.items.map((i) => (i.kind === "awaiting" ? i.row.id : 0))).toEqual([2]);
    expect(usePeople.getState().list?.open[0]?.items).toHaveLength(1);
  });

  it("their last item done: the row leaves Open and falls into its place in Everyone", () => {
    const list: PeopleList = { open: [open("ana@x.test", "Ana Ruiz", [waiting(1, "Phase 2")])], everyone: [{ name: "Bea", email: "bea@x.test", key: "bea@x.test", last: 0, written: true }, { name: "Ana Ruiz", email: "ana@x.test", key: "ana@x.test", last: 0, written: true }], everyoneVersion: 1, index: "ready" };
    expect(peopleRows(list, "", null).map((r) => r.id)).toEqual(["open", "ana@x.test", "everyone", "bea@x.test"]);
    expect(peopleRows(withoutListItem(list, "waiting:1"), "", null).map((r) => r.id)).toEqual(["everyone", "bea@x.test", "ana@x.test"]);
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
    const moved = { ...page, items: [page.items[1]!, page.items[0]!] };
    let acted = false;
    call.mockImplementation((method: string) => {
      if (method === "followups.act") {
        // nothing taken out while the act is on its way
        expect(usePeople.getState().page?.items).toHaveLength(2);
        acted = true;
        return Promise.resolve({ undoId: "u1" });
      }
      return Promise.resolve(method === "people.person" ? moved : { open: [], everyone: [], everyoneVersion: 1, index: "ready" });
    });
    await actOnPersonItem(page.items[1]!, "later", Date.now() + 86_400_000);
    expect(acted).toBe(true);
    expect(call).toHaveBeenCalledWith("followups.act", expect.objectContaining({ id: 2, action: "later" }));
    // the answer moves it (its new place, as read)
    expect(usePeople.getState().page?.items.map((i) => (i.kind === "awaiting" ? "owed" : "waiting"))).toEqual(["owed", "waiting"]);
  });
});

describe("j and k", () => {
  it("walk the people (headings skipped), each one's page with them, from the selected one", () => {
    navigate({ people: true });
    call.mockResolvedValue(null);
    usePeople.setState({ list: { open: [open("a@x.test", "A", [waiting(1, "One")])], everyone: [{ name: "B", email: "b@x.test", key: "b@x.test", last: 0, written: true }, { name: "C", email: "c@x.test", key: "c@x.test", last: 0, written: true }], everyoneVersion: 1, index: "ready" } });
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

describe("Enter in the search (Codex review of the QA fixes)", () => {
  const ana = { name: "Ana Ruiz", email: "ana@x.test", key: "ana@x.test", last: 1, written: true, open: 0 };
  const list: PeopleList = { open: [], everyone: [ana], everyoneVersion: 1, index: "ready" };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const answers = () => {
    const pending: ((v: unknown) => void)[] = [];
    call.mockImplementation((method: string) => (method === "people.search" ? new Promise((r) => pending.push(r)) : Promise.resolve(null)));
    return pending;
  };

  it("opens what's typed once its answer is in, also when the same words were searched and cleared before", async () => {
    navigate({ people: true });
    setApp({ person: null });
    usePeople.setState({ list });
    const pending = answers();
    searchPeople("ana");
    pending.shift()!({ hits: [ana], index: "ready" });
    await tick();
    searchPeople("");
    searchPeople("ana");
    enterSearch();
    // (the cleared search's answer is no answer to this one: it waits)
    expect(getApp().person).toBe(null);
    pending.shift()!({ hits: [ana], index: "ready" });
    await tick();
    expect(getApp().person).toBe("ana@x.test");
  });

  it("waits through an answer while the contacts warm up, then opens the ready one's first", async () => {
    navigate({ people: true });
    setApp({ person: null });
    usePeople.setState({ list });
    const pending = answers();
    searchPeople("an");
    enterSearch();
    pending.shift()!({ hits: [], index: "warming" });
    await tick();
    expect(getApp().person).toBe(null);
    // (the index ready: the same words asked again)
    searchPeople("an");
    pending.at(-1)!({ hits: [ana], index: "ready" });
    await tick();
    expect(getApp().person).toBe("ana@x.test");
  });

  it("a press elsewhere before the answer: nothing opens", async () => {
    navigate({ people: true });
    setApp({ person: null });
    usePeople.setState({ list });
    const pending = answers();
    searchPeople("ana r");
    enterSearch();
    window.dispatchEvent(new Event("pointerdown"));
    pending.shift()!({ hits: [ana], index: "ready" });
    await tick();
    expect(getApp().person).toBe(null);
  });
});

describe("Done by a click (Codex review of the QA fixes)", () => {
  it("guards the items against the double click's second, though the click focused the button first", async () => {
    navigate({ people: true });
    setApp({ person: "ana@x.test" });
    const page: PersonPage = { key: "ana@x.test", email: "ana@x.test", name: "Ana Ruiz", items: [waiting(1, "Phase 2"), waiting(3, "Budget")], conversations: [], more: false };
    usePeople.setState({ page, list: { open: [open("ana@x.test", "Ana Ruiz", page.items)], everyone: [], everyoneVersion: 1, index: "ready" } });
    document.body.innerHTML = `<section data-testid="person-page"><ul><li data-testid="person-item" data-item="waiting:1"><button id="done">Done</button></li></ul></section>`;
    document.getElementById("done")!.focus();
    call.mockImplementation(() => Promise.resolve(null));
    const acting = actOnPersonItem(page.items[0]!, "done", undefined, "pointer");
    expect(document.querySelector<HTMLElement>("[data-testid=person-page]")!.dataset.shield).toBe("");
    await acting;
    document.body.innerHTML = "";
  });
});

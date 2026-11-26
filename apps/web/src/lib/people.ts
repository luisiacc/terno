import { personItemId, personKey, type PersonItem, type PersonPage } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import type { LeftRows } from "~/lib/actions";
import { aiFeaturesOffered } from "~/lib/ai";
import { actOnTask, taskOf } from "~/lib/dated";
import { actOnFollowup } from "~/lib/followups";
import { morph } from "~/lib/morph";
import { listLayout, openThread } from "~/lib/page";
import { noteOpen } from "~/lib/reminders";
import { client } from "~/rpc/connection";
import { getApp, navigate, setApp, useApp } from "~/state/app";
import { peopleRows, usePeople } from "~/state/people";
import { loadThread } from "~/state/threads";

/**
 * Plan 281: People's ways in and out, its reads and its acts. The list and the page are read when People opens and again
 * when What matters changes (`todayChanged`, which follow-ups' changes raise too) or, for the page, when mail changes
 * (`changed`): nothing is polled. A change an act or its Undo made is drawn as one morph (plan 251): the item leaves the
 * page, the items under it glide up, and the person's row in the list moves to its new place, together.
 */

/** an act's change is owed motion until this moment: the next answers to arrive morph */
let owedUntil = 0;
const OWED_MS = 2000;
const owe = () => (owedUntil = Date.now() + OWED_MS);
const owed = () => Date.now() < owedUntil;

/** A change drawn as one morph when an act owes it, else at once. */
function draw(update: () => void, moving: boolean): void {
  if (moving) morph(update);
  else update();
}

/** The sidebar's People: the view, its list read (the selected person's page with it). */
export function openPeople(): void {
  navigate({ people: true });
  void loadPeople();
}

let listSeq = 0;
let waitingForIndex = false;

/** Reads the list (Open, Everyone); while the index is being made ready, one call waits for it, then the list reads again. */
export async function loadPeople(): Promise<void> {
  const mine = ++listSeq;
  const moving = owed();
  try {
    const list = await client.call("people.list", {});
    if (mine !== listSeq || !getApp().people) return;
    draw(() => usePeople.setState({ list }), moving);
    if (list.index === "warming" && !waitingForIndex) {
      waitingForIndex = true;
      void client
        .call("people.ready", {})
        .then(() => {
          if (getApp().people) void loadPeople();
        })
        .catch(() => {})
        .finally(() => (waitingForIndex = false));
    }
  } catch {
    // the next change reads it again; what was shown stays
  }
}

let searchSeq = 0;

/** What's typed in the list's field: names and addresses only, answered as it's typed (a late answer is dropped). */
export function searchPeople(query: string): void {
  const mine = ++searchSeq;
  usePeople.setState({ query, ...(query.trim() ? {} : { hits: null }) });
  if (!query.trim()) return;
  client.call("people.search", { query }).then(
    (hits) => {
      if (mine === searchSeq) usePeople.setState({ hits });
    },
    (error: unknown) => {
      if (!(error instanceof RpcError && error.code === "CANCELLED") && mine === searchSeq) usePeople.setState({ hits: { hits: [], index: "ready" } });
    },
  );
}

let pageSeq = 0;

/** Selects a person: their page shows (the reader in Split, the list's pane in List), read now. */
export function selectPerson(key: string, email: string): void {
  const s = getApp();
  if (s.person === key && s.selectedId === null) return;
  setApp({ person: key, selectedId: null, readerOpen: false });
  void loadPage(key, email);
}

/** Back from a person's page in List (its "‹ People" and Esc): the list again, where it was. */
export function leavePerson(): void {
  if (getApp().person === null) return;
  pageSeq++;
  setApp({ person: null, selectedId: null });
  usePeople.setState({ page: null, reading: null });
}

async function loadPage(key: string, email: string): Promise<void> {
  const mine = ++pageSeq;
  const moving = owed();
  const shown = usePeople.getState().page;
  usePeople.setState({ reading: { key, email }, ...(shown?.key === key ? {} : { page: null }) });
  try {
    const page = await client.call("people.person", { email });
    if (mine !== pageSeq || getApp().person !== key) return;
    draw(() => usePeople.setState({ page, reading: null }), moving);
  } catch {
    if (mine === pageSeq) usePeople.setState({ reading: null });
  }
}

/** The selected person's page, read again (an act's answer, a change of mail). */
function reloadPage(): void {
  const s = getApp();
  const p = usePeople.getState();
  const email = p.page?.email ?? p.reading?.email;
  if (s.people && s.person !== null && email) void loadPage(s.person, email);
}

let opening = 0;

/**
 * An item or a conversation on a person's page opens its conversation: read first, then shown in one change (never an
 * empty reader); a newer click, another person or leaving People meanwhile opens nothing.
 */
export function openFromPerson(threadId: number): void {
  const mine = ++opening;
  const person = getApp().person;
  void loadThread(threadId).then(() => {
    const s = getApp();
    if (mine !== opening || !s.people || s.person !== person) return;
    noteOpen(threadId);
    openThread(threadId);
  });
}

/** Esc and the reader's Close on a conversation opened from a person's page (Split): their page again. */
export function closePersonConversation(): boolean {
  const s = getApp();
  if (!s.people || s.selectedId === null || listLayout()) return false;
  opening++;
  setApp({ selectedId: null });
  return true;
}

/**
 * Done, Remove and Later on an item of a person's page: What matters' own acts (one snack, one exact Undo), a reply owed to
 * you through follow-ups'. Done and Remove take the item off the page at once, in a morph; Later keeps it (it's still open,
 * further on): the answer moves it. The list's row follows with the answer, in a morph too.
 */
export async function actOnPersonItem(item: PersonItem, action: "done" | "dismiss" | "later", at?: number): Promise<void> {
  owe();
  const left = action === "later" ? afterAnswer() : takeOff(item);
  if (item.kind === "awaiting") return actOnFollowup(item.row, action, at, left);
  const task = taskOf(item.item.why, Date.now(), item.item.thread);
  if (task) await actOnTask(task, action, at, left);
}

/** Undo owes motion too: what comes back glides in. */
function afterAnswer(): LeftRows {
  return {
    async undo(run) {
      owe();
      await run();
    },
    failed: () => {},
  };
}

/** The item leaves the page now; a failure puts the page back as it was. */
function takeOff(item: PersonItem): LeftRows {
  const id = personItemId(item);
  const before = usePeople.getState().page;
  if (before) morph(() => usePeople.setState(({ page }) => ({ page: page && withoutItem(page, id) })));
  return {
    ...afterAnswer(),
    failed: () => {
      if (before && usePeople.getState().page?.key === before.key) morph(() => usePeople.setState({ page: before }));
    },
  };
}

export const withoutItem = (page: PersonPage, id: string): PersonPage => ({ ...page, items: page.items.filter((i) => personItemId(i) !== id) });

const morphIds = new Map<string, number>();
/**
 * A view-transition name for a person's row (`p`) or a page's item (`i`): a short stable one per key for the session (a key
 * is an address, never a CSS name), so the same person is the same element across a morph.
 */
export function morphName(kind: "p" | "i", key: string): string {
  const id = `${kind}:${key}`;
  let n = morphIds.get(id);
  if (n === undefined) morphIds.set(id, (n = morphIds.size));
  return `people-${kind}${n}`;
}

/** What the list component registers: bringing a person's row into view, and its search field. */
export const peopleList: { toKey?: (key: string) => void; focusSearch?: () => void } = {};

/** j/k in People: the next (or previous) person, their page with them; no motion (a key pressed many times a day). */
export function movePerson(delta: number): void {
  const { list, query, hits } = usePeople.getState();
  const people = peopleRows(list, query, hits, personKey).filter((r) => r.kind === "person");
  if (!people.length) return;
  const at = people.findIndex((r) => r.key === getApp().person);
  const next = people[at < 0 ? (delta > 0 ? 0 : people.length - 1) : Math.max(0, Math.min(people.length - 1, at + delta))]!;
  selectPerson(next.key, next.email);
  peopleList.toKey?.(next.key);
}

/** Opens People on someone (the person menu's "Open in People"): the view, then their page. */
export function openInPeople(email: string): void {
  if (!getApp().people) openPeople();
  selectPerson(personKey(email), email);
}

/**
 * The person card's reads (the chip's menu): asked for on the chip's hover or focus, kept per person until What matters
 * changes, so the menu opens with its head at once, or (asked only on the click) within `CARD_WAIT_MS`, else without it.
 */
const cards = new Map<string, { page: PersonPage | null; ready: Promise<PersonPage | null> }>();
export const CARD_WAIT_MS = 250;

/** Starts reading someone's card (nothing while AI features aren't offered). */
export function prefetchCard(email: string): Promise<PersonPage | null> {
  const key = personKey(email);
  const had = cards.get(key);
  if (had) return had.ready;
  if (!aiFeaturesOffered(getApp())) return Promise.resolve(null);
  const entry: { page: PersonPage | null; ready: Promise<PersonPage | null> } = { page: null, ready: Promise.resolve(null) };
  entry.ready = client.call("people.person", { email, conversations: 2 }).then(
    (page) => (entry.page = page),
    () => {
      cards.delete(key);
      return null;
    },
  );
  cards.set(key, entry);
  return entry.ready;
}

/** The card as read so far: null until it answers. */
export const cardOf = (email: string): PersonPage | null => cards.get(personKey(email))?.page ?? null;

/** Waits for the card at most `CARD_WAIT_MS` (the menu's open never waits longer). */
export async function cardWithin(email: string): Promise<PersonPage | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), CARD_WAIT_MS)));
  try {
    return await Promise.race([prefetchCard(email), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** At boot: People reads again when What matters or mail changes, only while it shows; the cards are read again when asked. */
export function installPeople(): void {
  client.on("todayChanged", () => {
    cards.clear();
    if (!getApp().people) return;
    void loadPeople();
    reloadPage();
  });
  client.on("changed", () => {
    if (getApp().people) reloadPage();
  });
  // AI features no longer offered: People goes (its row too), back to the Inbox
  useApp.subscribe((s, prev) => {
    if (s.people && aiFeaturesOffered(prev) && !aiFeaturesOffered(s)) navigate({ view: "inbox" });
  });
}

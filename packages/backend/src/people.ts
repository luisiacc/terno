import { isPersonRequest, PEOPLE_EVERYONE_MAX, PEOPLE_SEARCH_MAX, PERSON_CONVERSATIONS_MAX, personKey, type FollowupRow, type PeopleList, type PeopleSearch, type PersonItem, type PersonOpen, type PersonPage, type ThreadSummary, type TodayItem } from "@terno/core";
import type { BackendCore as Backend } from "./core";
import { readSettings } from "./settings";


/**
 * Plan 281: People. What's open between the user and each person, grouped from what What matters already decided (its
 * open part: your promises, conversations waiting on your answer, a person's requests) and the replies owed to you (the
 * follow-ups waiting on them); everyone you've written to and the search, from the recipient index. Nothing at all while
 * What matters isn't offered (its own rule, asked first by every call). The grouping is kept while What matters and the
 * index are as they were, and read again on the next ask after either changes: no timer, nothing done while nobody asks.
 */
export class PeopleService {
  private cache: { today: number; index: number; owed: boolean; open: Promise<PersonOpen[]> } | null = null;

  constructor(private readonly b: Backend) {}

  /**
   * Open and Everyone. Everyone needs the index: started here (as a recipient field starts it), never waited for; sent only
   * when it isn't the version the renderer holds (`known`).
   */
  async list(known?: number): Promise<PeopleList> {
    if (!(await this.b.today.offered())) return { open: [], everyone: [], everyoneVersion: -1, index: "ready" };
    void this.b.warmAutocomplete().catch(() => {});
    const open = await this.open();
    const index = this.b.autocomplete.peopleIndex();
    if (!index) return { open, everyone: [], everyoneVersion: -1, index: this.indexState() };
    const version = index.scoreVersion;
    if (known === version) return { open, everyoneVersion: version, index: "ready" };
    const mine = await this.mine();
    // one person under two spellings once, and never you; the open people are in it too, each at their place, so one
    // whose last item goes falls into it there (the list leaves them out while they're open)
    const seen = new Set<string>();
    const everyone = [];
    for (const p of index.written(PEOPLE_EVERYONE_MAX * 2)) {
      const key = personKey(p.email);
      if (seen.has(key) || mine.has(key)) continue;
      seen.add(key);
      everyone.push({ ...p, key });
      if (everyone.length === PEOPLE_EVERYONE_MAX) break;
    }
    return { open, everyone, everyoneVersion: version, index: "ready" };
  }

  /** Resolves when the index has answered (or given up): the list reads again then. One call, nothing polled. */
  async ready(): Promise<{ index: PeopleList["index"] }> {
    if (!(await this.b.today.offered())) return { index: "ready" };
    await this.b.warmAutocomplete().catch(() => {});
    return { index: this.indexState() };
  }

  /** Names and addresses only, never content; each hit with how many things are open with them. */
  async search(query: string): Promise<PeopleSearch> {
    if (!(await this.b.today.offered())) return { hits: [], index: "ready" };
    const index = this.b.autocomplete.peopleIndex();
    if (!index) return { hits: [], index: this.indexState() };
    const open = new Map((await this.open()).map((p) => [p.key, p.items.length]));
    const mine = await this.mine();
    const seen = new Set<string>();
    const hits = [];
    for (const h of index.people(query, PEOPLE_SEARCH_MAX)) {
      const key = personKey(h.email);
      if (mine.has(key) || seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...h, key, open: open.get(key) ?? 0 });
    }
    return { hits, index: "ready" };
  }

  /**
   * One person: what's open, their recent conversations (newest first, never Spam or Trash). For the card (`except`, the
   * conversation open beside it): the newest other one's stored summary, its "Last time"; the page reads none.
   */
  async person(email: string, conversations = PERSON_CONVERSATIONS_MAX, except?: number): Promise<PersonPage | null> {
    if (!(await this.b.today.offered())) return null;
    const key = personKey(email);
    // you're never a person here
    if ((await this.mine()).has(key)) return null;
    const found = (await this.open()).find((p) => p.key === key);
    const want = Math.max(0, Math.min(conversations, PERSON_CONVERSATIONS_MAX));
    // the address as it was seen (the search is exact on it), All Mail: Spam and Trash are left out by the store
    const page = want ? await this.b.store.threads.searchText({ query: email, place: "all", limit: want, now: this.b.now() }) : null;
    const shown = page?.items ?? [];
    const name = this.b.autocomplete.peopleIndex()?.person(email)?.name || found?.name || "";
    const last = except === undefined ? undefined : shown.find((t) => t.id !== except);
    const lastSummary = last ? (await this.b.today.summaryLine(last.id)).summary : undefined;
    // (the card says who wrote it: you, them, or someone else on it)
    const lastFromMe = last ? (await this.mine()).has(personKey(last.fromEmail)) : false;
    return {
      key,
      email,
      name,
      items: found?.items ?? [],
      conversations: shown,
      more: page?.nextCursor != null,
      ...(last && lastSummary ? { lastSummary, lastSummaryOf: last.id } : {}),
      ...(lastFromMe ? { lastFromMe } : {}),
    };
  }

  private indexState(): PeopleList["index"] {
    return this.b.autocomplete.peopleIndex() ? "ready" : this.b.autocomplete.gaveUp ? "off" : "warming";
  }

  /** Your own addresses as people keys (the accounts', and every one you've sent from, as the index knows them): never anyone in People. */
  private async mine(): Promise<ReadonlySet<string>> {
    const keys = new Set((await this.b.store.accounts.list()).map((a) => personKey(a.email)));
    for (const email of this.b.autocomplete.peopleIndex()?.ownEmails() ?? []) keys.add(personKey(email));
    return keys;
  }

  /**
   * The grouping, shared by the list, the search's counts and the page until What matters, the index or the follow-ups
   * switch changes (turning follow-ups off or on changes no row, so nothing else says it).
   */
  private async open(): Promise<PersonOpen[]> {
    const today = this.b.today.revision;
    // the index answering, or catching up, changes who a dated item's sender is (someone you've written to) and names
    const index = this.b.autocomplete.peopleIndex()?.scoreVersion ?? -1;
    const owed = (await readSettings(this.b.store)).followups?.enabled === true;
    if (this.cache?.today !== today || this.cache.index !== index || this.cache.owed !== owed) {
      const open = this.group(owed);
      this.cache = { today, index, owed, open };
      // a failed read isn't kept: the next ask tries again
      open.catch(() => {
        if (this.cache?.open === open) this.cache = null;
      });
    }
    return this.cache.open;
  }

  private async group(owed: boolean): Promise<PersonOpen[]> {
    const index = this.b.autocomplete.peopleIndex();
    const mine = await this.mine();
    const people = new Map<string, PersonOpen>();
    const give = (email: string | null | undefined, name: string | null | undefined, item: PersonItem) => {
      const address = email?.trim();
      if (!address) return;
      const key = personKey(address);
      if (mine.has(key)) return;
      let p = people.get(key);
      if (!p) people.set(key, (p = { key, email: address, name: "", items: [] }));
      if (!p.name && name?.trim()) p.name = name.trim();
      p.items.push(item);
    };
    // What matters' order is the order of urgency (Missed, today, waiting on you, the days ahead, Coming up); a row that
    // carries the reply's other promises (`also`) is one act, so it's given whole to its own person
    for (const item of await this.b.today.openItems()) {
      const who = personOf(item, (email) => index?.person(email)?.written === true);
      if (who) give(who.email, who.name, { kind: "today", item });
    }
    if (owed) for (const r of await this.owedToYou()) give(r.row.personEmail, r.row.personName, { kind: "awaiting", row: r.row, thread: r.thread });
    for (const p of people.values()) p.name = index?.person(p.email)?.name || p.name || p.email;
    return [...people.values()];
  }

  /**
   * The replies owed to you: follow-ups waiting on them, oldest wait first, by the follow-ups' own account
   * rule, their conversations as stored now (never in Trash or Spam). Read only: nothing is closed, made due or said.
   */
  private async owedToYou(): Promise<{ row: FollowupRow; thread: ThreadSummary }[]> {
    const { b } = this;
    const waits = (await b.store.followups.active()).filter((r) => r.kind === "awaiting" && r.personEmail);
    if (!waits.length) return [];
    const threads = new Map((await b.store.threads.summaries([...new Set(waits.map((r) => r.threadId))])).map((t) => [t.id, t]));
    const wanted = new Map<number, boolean>();
    const out: { row: FollowupRow; thread: ThreadSummary }[] = [];
    for (const row of waits) {
      const thread = threads.get(row.threadId);
      if (!thread || thread.inSpam || thread.inTrash) continue;
      if (!wanted.has(thread.accountId)) wanted.set(thread.accountId, await b.followupsWanted(thread.accountId));
      if (wanted.get(thread.accountId)) out.push({ row, thread });
    }
    return out.sort((x, y) => x.row.sentAt - y.row.sentAt || x.row.id - y.row.id);
  }
}

/**
 * Whom a What matters item is between you and: a promise's person (whom you promised), a waiting conversation's sender
 * (who's waiting on your answer), a dated item's sender when it's a person's request or someone you've written to (a bill
 * from a utility is What matters' alone); a reminder is nobody's.
 */
export function personOf(item: TodayItem, writtenTo: (email: string) => boolean): { email: string; name: string } | null {
  const { why, thread } = item;
  if (why.kind === "promise") return why.personEmail ? { email: why.personEmail, name: why.personName ?? "" } : null;
  if (why.kind === "waiting") return thread.fromEmail ? { email: thread.fromEmail, name: thread.fromName } : null;
  if (why.kind === "dated") {
    const from = item.from ?? (thread.fromEmail ? { email: thread.fromEmail, name: thread.fromName } : null);
    if (!from) return null;
    return isPersonRequest(why.item?.kind) || writtenTo(from.email) ? from : null;
  }
  return null;
}

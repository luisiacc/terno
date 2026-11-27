import { describe, expect, it } from "vitest";
import { CorpusError, demoCorpusDataset } from "./load";
import { wrongWeekdays } from "./rules";
import type { CorpusSources, Person, StyleCard, ThreadRecord, World } from "./types";

const style = (o: Partial<StyleCard> = {}): StyleCard => ({ register: "plain", length: "short", greeting: "none", signoff: "none", signature: null, quoting: "bottom", quirks: [], ...o });
const person = (id: string, name: string, email: string, accounts: Person["accounts"], o: Partial<Person> = {}): Person => ({ id, name, email, lang: "en", timezone: "Europe/London", accounts, relationship: "friend", style: style(), facts: [], ...o });
const truth = { summary: "s", ownerOwes: [], othersOwe: [], promisesByOwner: [], promisesToOwner: [], keyDates: [], facts: [] };

function world(): World {
  return {
    anchor: "2026-10-22T15:30:00Z",
    owner: { name: "Luis Cordero", bio: "b", timezone: "Europe/London", style: { en: style(), es: style() } },
    accounts: [
      { key: "personal", kind: "gmail", email: "luis.cordero@gmail.com", displayName: "Personal", ownerName: "Luis Cordero", color: "brown", lang: "en", weight: 1, folders: [{ key: "Label_11", path: ["Family"], selectable: true, tags: ["personal"] }] },
      { key: "freelance", kind: "imap", email: "hola@luiscordero.example", displayName: "Freelance", ownerName: "Luis Cordero", color: "amber", lang: "es", weight: 1, folders: [{ key: "Clientes antiguos", path: ["Clientes antiguos"], selectable: true, tags: ["client"] }] },
    ],
    categories: [{ name: "Reading", color: "violet", tags: ["newsletter"] }],
    timeline: [],
    people: [
      person("niamh", "Niamh Gallagher", "niamh@proton.me", ["personal"], { style: style({ quoting: "top" }) }),
      person("tom", "Tom Ashworth", "tom@gmail.com", ["personal"]),
      person("ivan", "Iván Castillo", "ivan@semillaviva.example", ["freelance"], { lang: "es", timezone: "America/Mexico_City" }),
    ],
    orgs: [],
    brands: [{ id: "grid", name: "Grid & Gutter", domain: "gridandgutter.example", fromName: "Grid & Gutter", fromEmail: "hello@gridandgutter.example", kind: "newsletter", lang: "en", accounts: ["personal"], tag: "newsletter", listId: "news.gridandgutter.example", about: "", cadence: "weekdays" }],
    storylines: [],
  };
}

const threads: ThreadRecord[] = [
  {
    id: "t1",
    account: "personal",
    lang: "en",
    tags: ["personal"],
    subject: "Saturday?",
    folder: "Label_11",
    state: { inbox: true },
    messages: [
      { from: "tom", to: ["me"], date: "2026-10-20T19:02:00+01:00", read: true, text: "pub saturday mate" },
      { from: "me", to: ["tom"], cc: ["niamh"], date: "2026-10-20T21:40:00+01:00", read: true, text: "go on then, 7?" },
      { from: "niamh", to: ["me", "tom"], date: "2026-10-22T13:58:00+01:00", read: false, text: "count me in x" },
    ],
    truth,
  },
  {
    id: "t2",
    account: "freelance",
    lang: "es",
    tags: ["client"],
    subject: "Fotos de las escuelas",
    folder: "Clientes antiguos",
    state: { inbox: false },
    messages: [
      { from: "ivan", to: ["me"], date: "2026-09-01T10:00:00-06:00", read: true, text: "Hola Luis! Te mando las fotos de las escuelas que me pediste para la página." },
      { from: "me", to: ["ivan"], date: "2026-09-01T18:30:00+01:00", read: true, text: "Gracias, Iván. Las reviso y te escribo mañana con lo que falte." },
    ],
    truth,
  },
];

const sources = (o: Partial<CorpusSources> = {}): CorpusSources => ({
  world: world(),
  lists: [],
  threads,
  bulk: [
    {
      brand: "grid",
      account: "personal",
      schedule: { every: "weekdays", at: "06:30", zone: "Europe/London", from: "2026-10-12" },
      templates: [],
      issues: Array.from({ length: 15 }, (_, i) => ({ subject: `Grid & Gutter, {date} (${i})`, text: `Issue ${i}: kerning, grids and https://gridandgutter.example/i/${i}` })),
    },
  ],
  spam: [],
  ...o,
});

describe("the written demo mailbox's loader (plan 292)", () => {
  it("is deterministic and inserts in date order, newest last", () => {
    const a = demoCorpusDataset(sources());
    expect(JSON.stringify(demoCorpusDataset(sources()))).toBe(JSON.stringify(a));
    const dates = a.messages.map((m) => m.date);
    expect(dates).toEqual([...dates].sort((x, y) => x - y));
    expect(a.messages.at(-1)!.date).toBeLessThanOrEqual(Date.parse("2026-10-22T15:30:00Z"));
  });

  it("chains a thread's headers and quotes the message before in the replier's habit", () => {
    const t1 = demoCorpusDataset(sources()).messages.filter((m) => m.providerThreadId === "gth-t1");
    expect(t1.map((m) => m.inReplyTo)).toEqual([null, t1[0]!.rfcMessageId, t1[1]!.rfcMessageId]);
    expect(t1[2]!.references).toEqual([t1[0]!.rfcMessageId, t1[1]!.rfcMessageId]);
    expect(new Set(t1.map((m) => m.rfcMessageId)).size).toBe(3);
    expect(t1[1]!.subject).toBe("Re: Saturday?");
    // Luis quotes at the bottom, Niamh's client at the top
    expect(t1[1]!.bodyText).toMatch(/^go on then, 7\?\n\nOn Tue, 20 Oct 2026 at 19:02, Tom Ashworth <tom@gmail.com> wrote:\n> pub saturday mate$/);
    expect(t1[2]!.bodyText.startsWith("On Tue, 20 Oct 2026 at 21:40, Luis Cordero <luis.cordero@gmail.com> wrote:\n> go on then, 7?")).toBe(true);
    expect(t1[2]!.bodyText.endsWith("\n\ncount me in x")).toBe(true);
    expect(t1[2]!.snippet).toBe("count me in x");
  });

  it("sets Gmail's labels and the flags from who sent what", () => {
    const [tom, me, niamh] = demoCorpusDataset(sources()).messages.filter((m) => m.providerThreadId === "gth-t1");
    expect(me).toMatchObject({ isSent: true, isRead: true, inInbox: false });
    expect(me!.gmailLabels).toEqual(["Label_11", "SENT"]);
    expect(tom!.gmailLabels).toEqual(["Label_11", "INBOX", "CATEGORY_PERSONAL"]);
    expect(niamh).toMatchObject({ isSent: false, isRead: false, inInbox: true });
    expect(niamh!.gmailLabels).toEqual(["Label_11", "INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
  });

  it("files IMAP mail with UIDVALIDITY 1 and UIDs in date order per mailbox, and quotes in Spanish", () => {
    const t2 = demoCorpusDataset(sources()).messages.filter((m) => m.providerMsgId.startsWith("d-t2-"));
    expect(t2.map((m) => m.providerThreadId)).toEqual([null, null]);
    expect(t2.map((m) => m.locations)).toEqual([
      [{ mailbox: "Clientes antiguos", uidvalidity: 1, uid: 1, flags: ["\\Seen"] }],
      [{ mailbox: "Clientes antiguos", uidvalidity: 1, uid: 2, flags: ["\\Seen"] }],
    ]);
    expect(t2[1]!.subject).toBe("RE: Fotos de las escuelas");
    // Iván wrote at 10:00 in Mexico City: the attribution is his own clock
    expect(t2[1]!.bodyText).toContain("El mar, 1 sept 2026 a las 10:00, Iván Castillo <ivan@semillaviva.example> escribió:");
  });

  it("puts a newsletter on its schedule, newest issue on the newest date, unread and Primary on the demo day", () => {
    const grid = demoCorpusDataset(sources()).messages.filter((m) => m.from.email === "hello@gridandgutter.example");
    // weekdays from Monday 12 October to Thursday 22 October at 06:30 London (05:30 UTC)
    expect(grid).toHaveLength(9);
    const today = grid.at(-1)!;
    // at 06:30 London, plus up to 90 s so a sender's mail isn't stamped on the minute
    expect(today.date - Date.parse("2026-10-22T05:30:00Z")).toBeGreaterThanOrEqual(0);
    expect(today.date - Date.parse("2026-10-22T05:30:00Z")).toBeLessThan(90_000);
    expect(today.subject).toBe("Grid & Gutter, 22 October 2026 (0)");
    expect(today).toMatchObject({ isRead: false, inInbox: true, bulk: true, listId: "news.gridandgutter.example", unsubscribe: { mailto: "mailto:unsubscribe@gridandgutter.example?subject=unsubscribe" } });
    expect(today.gmailLabels).toEqual(["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
  });

  it("mails every other week, and monthly on the nth weekday", () => {
    const issues = Array.from({ length: 6 }, (_, i) => ({ subject: `n${i}`, text: `issue ${i}` }));
    const dates = (schedule: CorpusSources["bulk"][number]["schedule"]) =>
      demoCorpusDataset(sources({ bulk: [{ brand: "grid", account: "personal", schedule, templates: [], issues }] }))
        .messages.filter((m) => m.bulk)
        .map((m) => new Date(m.date).toISOString().slice(0, 10));
    expect(dates({ every: "fortnightly", day: 1, at: "08:00", zone: "Europe/London", from: "2026-09-01" })).toEqual(["2026-09-07", "2026-09-21", "2026-10-05", "2026-10-19"]);
    // the first Thursday: 3 September, 1 October
    expect(dates({ every: "monthly", nth: [1, 4], at: "10:00", zone: "Europe/Copenhagen", from: "2026-09-01" })).toEqual(["2026-09-03", "2026-10-01"]);
    const work = dates({ every: "random", perWeek: [6, 10], workdays: true, zone: "Europe/London", from: "2026-06-01" });
    expect(work.length).toBeGreaterThan(80);
    expect(work.filter((d) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))).toEqual([]);
  });

  it("draws slots independently, even when their names differ only at the end", () => {
    const template = { subject: "{ref} {a1} {a2} {a3}", text: "t", slots: { ref: { ref: "AS-####" }, a1: ["x", "y", "z", "w"], a2: ["x", "y", "z", "w"], a3: ["x", "y", "z", "w"] } };
    const w = world();
    w.brands = [{ ...w.brands[0]!, kind: "receipt", tag: "receipt" }];
    const subjects = demoCorpusDataset(sources({ world: w, bulk: [{ brand: "grid", account: "personal", schedule: { every: "daily", at: "09:00", zone: "Europe/London", from: "2026-08-01" }, templates: [template] }] }))
      .messages.filter((m) => m.bulk)
      .map((m) => m.subject);
    // a reference isn't one digit repeated, and the three slots don't move together
    expect(subjects.filter((s) => /^AS-(\d)\1\1\1 /.test(s)).length).toBeLessThan(subjects.length / 10);
    expect(subjects.filter((s) => { const [, a, b, c] = s.split(" "); return a === b && b === c; }).length).toBeLessThan(subjects.length / 4);
  });

  it("keeps a send's wall time across a clock change, and nothing after the anchor (Codex code review)", () => {
    const w = world();
    w.brands = [{ ...w.brands[0]!, kind: "receipt", tag: "receipt" }];
    const at = (schedule: CorpusSources["bulk"][number]["schedule"]) =>
      demoCorpusDataset(sources({ world: w, bulk: [{ brand: "grid", account: "personal", schedule, templates: [{ subject: "s", text: "t" }] }] })).messages.filter((m) => m.bulk);
    // New York springs forward at 02:00 on Sunday 8 March 2026: 03:00 there is 07:00 UTC that day (EDT), 08:00 the day
    // before (EST); reading the offset at 03:00 UTC, still the evening before, put the Sunday send at 04:00 local
    const ny = at({ every: "daily", at: "03:00", zone: "America/New_York", from: "2026-03-07", to: "2026-03-08" }).map((m) => new Date(m.date).toISOString().slice(0, 13));
    expect(ny).toEqual(["2026-03-07T08", "2026-03-08T07"]);
    // 15:29 London plus up to 90 s of jitter never passes the 15:30 UTC anchor (London is UTC+1 then: 16:29 local)
    expect(at({ every: "daily", at: "16:29", zone: "Europe/London", from: "2026-10-01" }).every((m) => m.date <= Date.parse("2026-10-22T15:30:00Z"))).toBe(true);
  });

  it("gives two sends on the same second their own ids (Codex code review)", () => {
    const w = world();
    w.brands = [{ ...w.brands[0]!, kind: "receipt", tag: "receipt" }];
    const sent = demoCorpusDataset(sources({ world: w, bulk: [{ brand: "grid", account: "personal", schedule: { every: "random", perWeek: [300, 300], zone: "Europe/London", from: "2026-10-01" }, templates: [{ subject: "s", text: "t" }] }] })).messages.filter((m) => m.bulk);
    expect(sent.length).toBeGreaterThan(500);
    expect(new Set(sent.map((m) => m.providerMsgId)).size).toBe(sent.length);
    expect(new Set(sent.map((m) => m.rfcMessageId)).size).toBe(sent.length);
  });

  it("refuses a link a template's slot fills in, a batch gone missing, and an account that can't be made (Codex code review)", () => {
    const w = world();
    w.brands = [{ ...w.brands[0]!, kind: "receipt", tag: "receipt" }];
    const link = { subject: "s", text: "see {url}", slots: { url: ["https://real-shop.com/r/1"] } };
    expect(() => demoCorpusDataset(sources({ world: w, bulk: [{ brand: "grid", account: "personal", schedule: { every: "daily", zone: "Europe/London", from: "2026-10-20" }, templates: [link] }] }))).toThrow(/link to real-shop.com/);
    const seed = { id: "t9", account: "personal", lang: "en", kind: "k", people: [], shape: "fyi", outcome: "o", messages: [1, 1], window: ["2026-10-01", "2026-10-02"], length: "short", attachments: "none", tags: ["personal"], inbox: true, must: [] } as const;
    expect(() => demoCorpusDataset(sources({ seeds: [{ ...seed, messages: [1, 1], window: ["2026-10-01", "2026-10-02"], tags: ["personal"], people: [], must: [] }] }))).toThrow(/seed not written/);
    const bad = world();
    (bad.accounts[1] as { kind: string }).kind = "pop3";
    expect(() => demoCorpusDataset(sources({ world: bad }))).toThrow(/kind "pop3"/);
  });

  it("refuses a corpus with an error before building anything", () => {
    const bad = structuredClone(threads);
    bad[0]!.messages[0]!.text = "Hope you're well. Visit https://real-company.com";
    expect(() => demoCorpusDataset(sources({ threads: bad }))).toThrow(CorpusError);
    const spanish = structuredClone(threads);
    spanish[0]!.messages[0]!.text = "¿nos vemos el sábado?";
    expect(() => demoCorpusDataset(sources({ threads: spanish }))).toThrow(/Spanish letters/);
  });

  it("holds a named weekday to the calendar of the year nearest the message", () => {
    const sent = Date.parse("2026-10-20T10:00:00Z");
    expect(wrongWeekdays("Thursday 5 November works, or Friday 6 November", sent)).toEqual([]);
    expect(wrongWeekdays("see you Thursday 6 November", sent)).toEqual(['"Thursday 6 November" is a friday (2026-11-06)']);
    expect(wrongWeekdays("el lunes 26 de octubre", sent)).toEqual([]);
  });
});

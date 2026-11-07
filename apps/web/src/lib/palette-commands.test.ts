import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { defaultFilter } from "cmdk";
import { describe, expect, it } from "vitest";
import { arrange, CONVERSATION_LEAD, itemValue, words, match, ranked, RECENT, scoreOf, type PaletteCommand } from "./palette-commands";
import { recordUse, type Usage } from "./palette-usage";

const cmd = (id: string, group: PaletteCommand["group"], extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, group, label: id, icon: null, ...extra });

const archive = cmd("thread.archive", "actions", { label: "Archive conversation", aliases: ["done", "mark done"], keywords: ["Archivar conversación"] });

describe("palette matching", () => {
  it("plan 158: an alias is said only when it's why the row is here", () => {
    const compose = cmd("compose.new", "start", { label: "New message", aliases: ["compose", "new", "write"] });
    expect(match(compose, "compose").alias).toBe("compose");
    expect(match(compose, "new").alias).toBeNull();
  });

  it("scores each text on its own and names the alias that matched", () => {
    expect(match(archive, "arch")).toMatchObject({ alias: null });
    expect(match(archive, "arch").score).toBeGreaterThan(0.9);
    expect(match(archive, "done")).toEqual({ score: 1, alias: "done" });
    // an English keyword matches without being shown
    expect(match(archive, "archivar")).toMatchObject({ alias: null });
    expect(match(archive, "archivar").score).toBeGreaterThan(0);
    expect(match(archive, "zzz").score).toBe(0);
  });

  it("never matches across two texts", () => {
    // "chive do" spans the label's end and an alias's start: one concatenated string would match it
    expect(match(archive, "conversationdone").score).toBe(0);
  });

  it("matches the search text, not the display label", () => {
    const move = cmd("move:1", "actions", { label: "Move to “Viajes”", search: "move to Viajes", searchOnly: true, scale: 0.5 });
    const go = cmd("category:1", "goTo", { label: "Viajes", search: "category Viajes" });
    expect(match(move, "move viajes").score).toBeGreaterThan(0.5);
    // a bare name is the category, not the action on it, even with heavy use of the action
    const heavy = new Map([["move:1", { n: 10_000, at: 0 }]]);
    expect(scoreOf(go, "viajes", new Map(), 0)).toBeGreaterThan(scoreOf(move, "viajes", heavy, 0));
    // with the verb it's the action (the category's own text has no "m")
    expect(scoreOf(move, "move viajes", new Map(), 0)).toBeGreaterThan(scoreOf(go, "move viajes", new Map(), 0));
  });

  it("boosts with use but never past an exact match", () => {
    const usage: Usage = new Map([["a", { n: 1000, at: 0 }]]);
    expect(ranked(0, "a", usage, 0)).toBe(0);
    expect(ranked(1, "a", usage, 0)).toBe(1);
    expect(ranked(0.99, "a", usage, 0)).toBe(0.995);
    expect(ranked(0.4, "a", usage, 0)).toBeCloseTo(0.6);
    expect(ranked(0.4, "b", usage, 0)).toBe(0.4);
  });

  it("gives each item a value unique by id", () => {
    expect(itemValue(archive)).not.toBe(itemValue({ ...archive, id: "thread.trash" }));
  });
});

describe("plan 158: presets beside an exact action", () => {
  const presets = ["tomorrow", "laterToday", "weekend", "nextWeek"].map((p) =>
    cmd(`remind:noReply:${p}`, "actions", { label: `Remind me if no reply: ${p}`, searchOnly: true, scale: 0.5 }),
  );
  const reply = cmd("compose.reply", "conversation", { label: "Reply" });
  const shown = (q: string) => arrange([reply, ...presets], "root", q, new Map(), 0).flatMap((g) => g.commands.map((c) => c.command.id));

  it("show one of their family when the query names an action outright", () => {
    const ids = shown("reply");
    expect(ids[0]).toBe("compose.reply");
    expect(ids.filter((id) => id.startsWith("remind:"))).toHaveLength(1);
  });

  it("all show when they're what the query names", () => {
    expect(shown("remind me if no").filter((id) => id.startsWith("remind:"))).toHaveLength(4);
  });
});

describe("palette groups", () => {
  const all = [
    cmd("draft.send", "draft"),
    cmd("go.inbox", "goTo"),
    cmd("go.sent", "goTo"),
    cmd("thread.star", "actions"),
    cmd("thread.move", "actions", { page: "move" }),
    cmd("move:1", "actions", { label: "Move to Work", search: "move to Work", searchOnly: true }),
    cmd("move:1", "move", { label: "Work" }),
    cmd("settings:general", "settings"),
  ];
  const names = (a: ReturnType<typeof arrange>) => a.map((g) => [g.group, g.commands.map((c) => c.command.id)]);

  it("shows the root's groups in order, without search-only values", () => {
    expect(names(arrange(all, "root", "", new Map(), 0))).toEqual([
      ["draft", ["draft.send"]],
      ["goTo", ["go.inbox", "go.sent"]],
      ["actions", ["thread.star", "thread.move"]],
      ["settings", ["settings:general"]],
    ]);
  });

  it("leads an empty root with the recent commands, taken out of their groups", () => {
    let u: Usage = new Map();
    for (const [i, id] of ["go.sent", "draft.send", "move:1", "thread.move", "thread.star"].entries()) u = recordUse(u, id, i);
    const a = arrange(all, "root", "", u, 0);
    // a draft's commands stay in the draft group; pages aren't recent; a page's value is
    expect(names(a)).toEqual([
      ["draft", ["draft.send"]],
      ["recent", ["thread.star", "move:1", "go.sent"]],
      ["goTo", ["go.inbox"]],
      ["actions", ["thread.move"]],
      ["settings", ["settings:general"]],
    ]);
    expect(a[1]!.commands[1]!.command.label).toBe("Move to Work");
  });

  it("caps the recent commands", () => {
    const many = Array.from({ length: 10 }, (_, i) => cmd(`c${i}`, "actions"));
    let u: Usage = new Map();
    for (const [i, c] of many.entries()) u = recordUse(u, c.id, i);
    expect(arrange(many, "root", "", u, 0)[0]!.commands).toHaveLength(RECENT);
  });

  it("drops the recent group and shows matching values while typing", () => {
    const u = recordUse(new Map(), "thread.star", 1);
    const a = arrange(all, "root", "move wo", u, 0);
    expect(a.some((g) => g.group === "recent")).toBe(false);
    expect(a.find((g) => g.group === "actions")!.commands.map((c) => c.command.id)).toContain("move:1");
    // a value that doesn't match isn't rendered at all (many categories stay cheap)
    expect(arrange(all, "root", "inbox", u, 0).flatMap((g) => g.commands).some((c) => c.command.id === "move:1")).toBe(false);
  });

  it("orders matches best first, and groups by their best match", () => {
    const list = [
      cmd("account:1", "goTo", { label: "Acme Studio", search: "account Acme Studio luis@acme.studio" }),
      cmd("thread.archive", "actions", { label: "Archivar conversación", aliases: ["hecho", "listo"] }),
      cmd("design:x", "actions", { label: "Estilo: Lumen" }),
    ];
    const a = arrange(list, "root", "listo", new Map(), 0);
    expect(a[0]!.group).toBe("actions");
    expect(a[0]!.commands[0]).toEqual({ command: list[1], alias: "listo" });
  });

  it("the open conversation's actions rank above going elsewhere, for a real match", () => {
    const list = [
      cmd("go.archive", "goTo", { label: "Archive" }),
      cmd("thread.archive", "conversation", { label: "Archive conversation" }),
      cmd("go.spam", "goTo", { label: "Spam" }),
      cmd("thread.spam", "conversation", { label: "Mark as spam" }),
    ];
    const first = (q: string) => arrange(list, "root", q, new Map(), 0)[0]!.commands[0]!.command.id;
    expect(first("arch")).toBe("thread.archive");
    // an exact name of a place too, and however often the place is used
    expect(first("spam")).toBe("thread.spam");
    const heavy = new Map([["go.archive", { n: 10_000, at: 0 }]]);
    expect(arrange(list, "root", "arch", heavy, 0)[0]!.group).toBe("conversation");
    // no conversation open: nothing to lead with
    expect(arrange(list.filter((c) => c.group === "goTo"), "root", "arch", new Map(), 0)[0]!.group).toBe("goTo");
  });

  it("a precise query isn't diluted by what it only brushes", () => {
    const list = [cmd("go.starred", "goTo", { label: "Starred" }), cmd("design:a", "actions", { label: "Style: Atelier" }), cmd("updates", "actions", { label: "Restart to update" })];
    expect(arrange(list, "root", "star", new Map(), 0).flatMap((g) => g.commands.map((c) => c.command.id))).toEqual(["go.starred"]);
  });

  it("two rows for one intent show as one, unless the query asks for the other", () => {
    const list = [cmd("go.starred", "goTo", { label: "Starred" }), cmd("filter.starred", "actions", { label: "Show starred conversations", sameAs: "go.starred" })];
    const ids = (q: string) => arrange(list, "root", q, new Map(), 0).flatMap((g) => g.commands.map((c) => c.command.id));
    expect(ids("star")).toEqual(["go.starred"]);
    expect(ids("show star")).toEqual(["filter.starred"]);
  });

  it("an empty root leads with a few of the conversation's actions; the rest wait under Actions", () => {
    const list = [cmd("go.inbox", "goTo"), cmd("other", "actions"), ...Array.from({ length: CONVERSATION_LEAD + 2 }, (_, i) => cmd(`thread.${i}`, "conversation"))];
    const a = arrange(list, "root", "", new Map(), 0);
    expect(a.map((g) => g.group)).toEqual(["conversation", "goTo", "actions"]);
    expect(a[0]!.commands).toHaveLength(CONVERSATION_LEAD);
    expect(a[2]!.commands.map((c) => c.command.id)).toEqual([`thread.${CONVERSATION_LEAD}`, `thread.${CONVERSATION_LEAD + 1}`, "other"]);
  });

  it("keeps a typo, leaves out letters scattered through a long label", () => {
    expect(arrange([archive], "root", "arhcive", new Map(), 0)).toHaveLength(1);
    const list = [cmd("filter.unread", "actions", { label: "Show unread only", search: "Show unread only unread filter" }), cmd("addTo:1", "actions", { label: "Add to Clientes", search: "add to Clientes", searchOnly: true }), archive];
    expect(arrange(list, "root", "done", new Map(), 0).flatMap((g) => g.commands.map((c) => c.command.id))).toEqual(["thread.archive"]);
  });

  it("a pasted paragraph doesn't stall a keystroke, and its first words still match", () => {
    const many = Array.from({ length: 1500 }, (_, i) => cmd(`move:${i}`, "actions", { label: `Move to “Category number ${i}”`, search: `move to Category number ${i}`, searchOnly: true }));
    const long = "category nu".repeat(2000);
    const t0 = performance.now();
    arrange([...many, archive], "root", long, new Map(), 0);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(arrange([archive], "root", `archive ${"x".repeat(5000)}`, new Map(), 0)).toHaveLength(0);
    expect(arrange([archive], "root", `done${" ".repeat(70)}zzz`, new Map(), 0)).toHaveLength(1);
  });

  it("no synonym in the catalogs is the start of another command's name (it would outrank it)", () => {
    // each alias key, with the label it belongs to
    const own: Record<string, string> = {
      archive: "palette.archive", trash: "palette.trash", spam: "palette.spam", markRead: "palette.markRead", markUnread: "palette.markUnread",
      star: "actions.star", move: "palette.move", remind: "palette.remind", compose: "palette.compose", reply: "palette.reply",
      forward: "palette.forward", undo: "common.undo", theme: "palette.theme", shortcuts: "shortcuts.title", print: "palette.print",
      aiFilter: "palette.aiFilter", discard: "compose.discard", attach: "attachments.attach", send: "common.send", snippet: "palette.insertSnippet",
    };
    const labelOf = (catalog: Record<string, unknown>, key: string) => {
      const v = catalog[key];
      return typeof v === "string" ? v : (v as { one: string }).one;
    };
    for (const catalog of [en, es] as Record<string, unknown>[]) {
      const labels = Object.values(own).map((k) => labelOf(catalog, k));
      for (const [name, key] of Object.entries(own)) {
        for (const word of words(catalog[`palette.alias.${name}`] as string)) {
          for (const label of labels) {
            if (label === labelOf(catalog, key)) continue;
            expect(defaultFilter(label, word), `"${word}" (${name}) vs "${label}"`).toBeLessThan(0.9);
          }
        }
      }
    }
  });

  it("shows only its own groups on a page", () => {
    expect(names(arrange(all, "move", "", new Map(), 0))).toEqual([["move", ["move:1"]]]);
  });

  it("plan 93: the snippets page lists them, then New snippet; at the root a snippet shows only by its name", () => {
    const snippets = [
      ...all,
      cmd("draft.snippet", "draft", { label: "Insert snippet…", page: "snippets" }),
      cmd("snippet:s_a", "snippets", { label: "Intro call", search: "Intro call Hi there" }),
      cmd("snippet:s_b", "snippets", { label: "Thanks" }),
      cmd("snippet.new", "snippetsManage", { label: "New snippet…" }),
      cmd("snippet:s_a", "draft", { label: "Insert snippet: Intro call", search: "Intro call", searchOnly: true }),
    ];
    expect(names(arrange(snippets, "snippets", "", new Map(), 0))).toEqual([["snippets", ["snippet:s_a", "snippet:s_b"]], ["snippetsManage", ["snippet.new"]]]);
    expect(names(arrange(snippets, "snippets", "hi there", new Map(), 0))).toEqual([["snippets", ["snippet:s_a"]]]);
    expect(names(arrange(snippets, "root", "", new Map(), 0)).find(([g]) => g === "draft")).toEqual(["draft", ["draft.send", "draft.snippet"]]);
    expect(names(arrange(snippets, "root", "intro", new Map(), 0))[0]).toEqual(["draft", ["snippet:s_a"]]);
  });
});

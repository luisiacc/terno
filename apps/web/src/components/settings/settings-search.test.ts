import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX } from "./search-index";

/**
 * Plan 203: the search index and the rows Settings draws stay in step. Every row in Settings says which setting it is
 * (or `find={false}`), every setting in the index is drawn somewhere, and a row's fixed label and hint are its entry's.
 */
const here = import.meta.dirname;
const files = [
  ...readdirSync(here)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => join(here, f)),
  // the web's storage section sits in Settings → Storage
  join(here, "../../web/storage-section.tsx"),
];
const sources = files.map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** A JSX element's opening tag, from `<Name` to its closing `>` (braces and strings skipped). */
function openingTags(text: string, name: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${name}\\b`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + name.length + 1;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && text[i - 1] !== "=") break;
    }
    tags.push(text.slice(m.index, i + 1));
  }
  return tags;
}

const rows = sources.flatMap(({ path, text }) => openingTags(text, "SettingsRow").map((tag) => ({ path, tag })));
const groups = sources.flatMap(({ path, text }) => openingTags(text, "SettingsGroup").map((tag) => ({ path, tag })));
const literal = (tag: string, attr: string) => tag.match(new RegExp(`\\b${attr}=\\{t\\("([^"]+)"\\)\\}`))?.[1] ?? null;

/** Where each id is drawn: a row's or group's `find`, or `findAttrs` on another element. */
const drawn = new Map<string, Set<string>>();
for (const { path, text } of sources) {
  // a literal, a choice between literals (`find={desktop ? "a" : "b"}`), or findAttrs on another element
  for (const m of text.matchAll(/\bfind="([^"]+)"|\bfind=\{([^}]*)\}|findAttrs\("([^"]+)"\)/g)) {
    const ids = m[2] !== undefined ? [...m[2].matchAll(/"([^"]+)"/g)].map((q) => q[1]!) : [(m[1] ?? m[3])!];
    for (const id of ids) drawn.set(id, (drawn.get(id) ?? new Set()).add(path));
  }
}

describe("Settings' search index and its rows", () => {
  it("finds the rows to check", () => {
    expect(rows.length).toBeGreaterThan(90);
  });

  it("has every row in Settings say which setting it is", () => {
    expect(rows.filter(({ tag }) => !/\bfind=/.test(tag)).map(({ path, tag }) => `${path}: ${tag.slice(0, 80)}`)).toEqual([]);
  });

  it("draws every setting in the index, each in one place", () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !drawn.has(id))).toEqual([]);
    expect([...drawn].filter(([, paths]) => paths.size > 1).map(([id]) => id)).toEqual([]);
    expect([...drawn.keys()].filter((id) => !ids.includes(id as never))).toEqual([]);
  });

  it("gives a row with a fixed label and hint its entry's", () => {
    const byId = new Map(SETTINGS_INDEX.map((e) => [e.id as string, e as { label: unknown; hint?: string }]));
    const mismatches: string[] = [];
    for (const { tag } of [...rows, ...groups]) {
      const id = tag.match(/\bfind="([^"]+)"/)?.[1];
      const entry = id ? byId.get(id) : undefined;
      if (!entry) continue;
      const label = literal(tag, "label") ?? literal(tag, "title");
      if (label && typeof entry.label === "string" && label !== entry.label) mismatches.push(`${id}: label ${label} ≠ ${entry.label}`);
      const hint = literal(tag, "hint");
      if (hint && entry.hint && hint !== entry.hint) mismatches.push(`${id}: hint ${hint} ≠ ${entry.hint}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("points `under` at a setting that is drawn in the same section", () => {
    const byId = new Map(SETTINGS_INDEX.map((e) => [e.id as string, e]));
    for (const e of SETTINGS_INDEX) {
      if (!("under" in e)) continue;
      const parent = byId.get(e.under);
      expect(parent, e.id).toBeDefined();
      expect(parent!.tab, e.id).toBe(e.tab);
    }
  });

  it("marks the disclosures a scoped setting opens", () => {
    const all = sources.map((s) => s.text).join("\n");
    for (const kind of new Set(SETTINGS_INDEX.flatMap((e) => ("scope" in e ? [e.scope] : [])))) {
      expect(all, kind).toContain(`data-setting-scope={\`${kind}:`);
    }
    expect(all.match(/data-setting-open\b/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the entries a search runs on", async () => {
  const { setLocale } = await import("@terno/i18n");
  const en = (await import("@terno/i18n/locales/en")).default;
  const es = (await import("@terno/i18n/locales/es")).default;
  const { findEntries } = await import("./search-index");
  const { findSettings } = await import("~/lib/settings-find");
  const settings = { ai: { provider: "none", fromEnv: false, keys: {}, profiles: {} }, devAi: null } as unknown as Parameters<typeof findEntries>[0]["settings"];
  const ctx = { settings, desktop: true, devMode: false, notifications: true, badge: true, summaries: true, webStorage: false, agents: true, updater: false, accounts: 2 };
  const accounts = [
    { id: 1, displayName: "Work", kind: "gmail" },
    { id: 2, displayName: "Home", kind: "imap" },
  ] as unknown as Parameters<typeof findEntries>[1];
  const categories = [{ id: 7, name: "Receipts" }] as unknown as Parameters<typeof findEntries>[2];

  it("has one result per account for an account's setting, found by the account's name too", () => {
    const entries = findEntries(ctx, accounts, categories);
    expect(findSettings(entries, "signature").map((f) => f.entry.key)).toEqual(["account.signature:1", "account.signature:2"]);
    expect(findSettings(entries, "home signature").map((f) => f.entry.key)).toEqual(["account.signature:2"]);
    // Gmail's tabs only on the Gmail account, Sent copies only on the IMAP one
    expect(entries.filter((e) => e.data.id === "account.separateTabs").map((e) => e.key)).toEqual(["account.separateTabs:1"]);
    expect(entries.filter((e) => e.data.id === "account.sentCopies").map((e) => e.key)).toEqual(["account.sentCopies:2"]);
    expect(findSettings(entries, "receipts color")[0]?.entry.key).toBe("category.color:7");
  });

  it("plan 259 (Codex review #6): Outlook, Hotmail or Microsoft finds Add account, in English and Spanish", () => {
    const first = (q: string) => findSettings(findEntries(ctx, accounts, []), q)[0]?.entry.data.id;
    for (const q of ["outlook", "hotmail", "microsoft"]) expect(first(q), q).toBe("accounts.add");
    setLocale("es", es);
    try {
      for (const q of ["outlook", "microsoft"]) expect(first(q), q).toBe("accounts.add");
    } finally {
      setLocale("en", en);
    }
  });

  it("plan 238: the all-accounts Inbox's switch with several accounts, found as the unified inbox; with one, only while it's out", () => {
    const keys = (c: typeof ctx, list: typeof accounts) => findEntries(c, list, []).filter((e) => e.data.id === "account.allInbox").map((e) => e.key);
    expect(keys(ctx, accounts)).toEqual(["account.allInbox:1", "account.allInbox:2"]);
    expect(findSettings(findEntries(ctx, accounts, []), "home unified inbox")[0]?.entry.key).toBe("account.allInbox:2");
    const one = [accounts[0]!];
    expect(keys({ ...ctx, accounts: 1 }, one)).toEqual([]);
    expect(keys({ ...ctx, accounts: 1 }, [{ ...one[0]!, unified: false }] as typeof accounts)).toEqual(["account.allInbox:1"]);
  });

  it("leaves out what can't exist here", () => {
    const ids = (c: typeof ctx) => new Set(findEntries(c, [], []).map((e) => e.data.id));
    expect(ids(ctx).has("dev.proAi")).toBe(false);
    expect(ids({ ...ctx, devMode: true }).has("dev.proAi")).toBe(true);
    expect(ids({ ...ctx, notifications: false }).has("general.notify")).toBe(false);
    expect(ids({ ...ctx, agents: false }).has("agents.enabled")).toBe(false);
    // Codex code review: Summaries' group shows only when they can run; the badge in its platform's words; the web's engine
    expect(ids({ ...ctx, summaries: false }).has("ai.summaries")).toBe(false);
    expect([...ids(ctx)].filter((id) => id.startsWith("general.badge"))).toEqual(["general.badge"]);
    expect([...ids({ ...ctx, desktop: false })].filter((id) => id.startsWith("general.badge"))).toEqual(["general.badgeWeb"]);
    expect(ids(ctx).has("storage.engine")).toBe(false);
    expect(ids({ ...ctx, desktop: false, webStorage: true }).has("storage.engine")).toBe(true);
  });

  it("plan 247: with AI, What matters' settings are found in its own section, in its order, each by its row's rule", () => {
    const withAi = { ...ctx, settings: { ...settings, ai: { provider: "anthropic", model: "claude-sonnet-5-5", local: false, hasKey: true, keyConfirmed: true, keys: { anthropic: { hasKey: true, keyHint: null } }, profiles: {}, fromEnv: false } } as typeof settings };
    const entries = findEntries(withAi, accounts, []);
    const mine = entries.filter((e) => e.data.tab === "whatMatters").map((e) => e.data.id);
    expect(mine).toEqual(["whatMatters.show", "whatMatters.firstScreen", "whatMatters.finished", "whatMatters.dated", "whatMatters.words", "whatMatters.shown", "whatMatters.muted", "whatMatters.digest", "whatMatters.digestExcluded", "whatMatters.notify", "whatMatters.time", "whatMatters.accounts"]);
    // nothing of it is left in General or AI
    expect(entries.filter((e) => /^(general|ai)\.(today|firstScreen|keepInboxCount|digest|dated)/.test(e.data.id))).toEqual([]);
    expect(findSettings(entries, "digest")[0]?.entry.data.id).toBe("whatMatters.digest");
    // Codex code review: the left-out senders' list shows only with one; without, a search for it opens the digest's switch
    expect(entries.find((e) => e.data.id === "whatMatters.digestExcluded")?.data.under).toBe("whatMatters.digest");
    expect(findSettings(entries, "finished")[0]?.entry.data.id).toBe("whatMatters.finished");
    expect(findSettings(entries, "launch")[0]?.entry.data.id).toBe("whatMatters.firstScreen");
    expect(findSettings(entries, "launch")[0]?.entry.place.map((p) => p.text)).toEqual(["What matters"]);
    const ids = (c: typeof ctx, n = accounts) => new Set(findEntries(c, n, []).map((e) => e.data.id));
    // the Inbox's number only while What matters opens first; launch and it only while it's in the sidebar
    expect(ids({ ...withAi, settings: { ...withAi.settings, firstScreen: "whatMatters" } as typeof settings }).has("whatMatters.keepInboxCount")).toBe(true);
    const hidden = ids({ ...withAi, settings: { ...withAi.settings, today: { show: false } } as typeof settings });
    expect(hidden.has("whatMatters.firstScreen")).toBe(false);
    expect(hidden.has("whatMatters.show")).toBe(true);
    // a local build with Dev mode's Pro AI off: the section and its switch, not the launch
    const devOff = ids({ ...withAi, devMode: true, settings: { ...withAi.settings, devAi: false } as typeof settings });
    expect(devOff.has("whatMatters.show")).toBe(true);
    expect(devOff.has("whatMatters.firstScreen")).toBe(false);
    // with one account, Accounts' own switch
    expect(ids({ ...withAi, accounts: 1 }, [accounts[0]!]).has("whatMatters.accounts")).toBe(false);
    // without AI, none of it
    expect([...ids(ctx)].filter((id) => id.startsWith("whatMatters."))).toEqual([]);
  });

  it("in Spanish, finds by the English name and words too, and says so", () => {
    setLocale("es", es as never);
    try {
      const [found] = findSettings(findEntries(ctx, [], []), "undo send");
      expect(found?.entry.name).toBe(es["settings.general.undoSend"]);
      expect(found?.reason).toEqual({ kind: "word", word: "Undo send" });
      expect(findSettings(findEntries(ctx, [], []), "deshacer")[0]?.entry.data.id).toBe("general.undoSend");
    } finally {
      setLocale("en", en as never);
    }
  });
});

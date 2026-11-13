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
  for (const m of text.matchAll(/\bfind="([^"]+)"|findAttrs\("([^"]+)"\)/g)) {
    const id = (m[1] ?? m[2])!;
    drawn.set(id, (drawn.get(id) ?? new Set()).add(path));
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
  const ctx = { settings, desktop: true, devMode: false, notifications: true, badge: true, agents: true, updater: false };
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

  it("leaves out what can't exist here", () => {
    const ids = (c: typeof ctx) => new Set(findEntries(c, [], []).map((e) => e.data.id));
    expect(ids(ctx).has("dev.proAi")).toBe(false);
    expect(ids({ ...ctx, devMode: true }).has("dev.proAi")).toBe(true);
    expect(ids({ ...ctx, notifications: false }).has("general.notify")).toBe(false);
    expect(ids({ ...ctx, agents: false }).has("agents.enabled")).toBe(false);
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

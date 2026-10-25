import { afterEach, describe, expect, it } from "vitest";
import { compile, renderRich, renderText } from "./format";
import { formatList, formatNumber, getLocale, hasKey, isLocalized, keyRef, L, loadLocale, plainText, refText, LOCALES, onLocaleChange, resolveLocale, rich, setLocale, t, translate, type LocaleCheck, type Messages } from "./index";
import en from "./locales/en";
import es from "./locales/es";

afterEach(() => setLocale("en", en));

const placeholders = (m: string | object): string[] =>
  [...new Set((typeof m === "string" ? [m] : Object.values(m)).flatMap((s: string) => [...s.matchAll(/\{(\w+)\}|<(\w+)>/g)].map((x) => x[1] ?? `<${x[2]}>`)))].sort();

describe("t", () => {
  it("returns plain messages as they are", () => {
    expect(t("common.cancel")).toBe("Cancel");
  });

  it("fills placeholders, formatting numbers for the locale", () => {
    expect(t("language.system", { language: "English" })).toBe("System (English)");
    setLocale("en", { ...en, "language.system": "{language} · {language}" } as Messages);
    expect(t("language.system", { language: "x" })).toBe("x · x");
  });

  it("picks plural sentences with Intl.PluralRules, # formatted", () => {
    expect(t("common.conversations", { count: 1 })).toBe("1 conversation");
    expect(t("common.conversations", { count: 0 })).toBe("0 conversations");
    expect(t("common.conversations", { count: 12_345 })).toBe("12,345 conversations");
    setLocale("es", es);
    expect(t("common.conversations", { count: 1 })).toBe("1 conversación");
    expect(t("common.conversations", { count: 2 })).toBe("2 conversaciones");
    // Spanish's "many" (1 000 000) has no sentence of its own: other
    expect(t("common.conversations", { count: 1_000_000 })).toBe("1,000,000 conversaciones");
  });

  it("prefers an exact =N sentence", () => {
    setLocale("en", { ...en, "common.conversations": { "=0": "No conversations", one: "# conversation", other: "# conversations" } } as Messages);
    expect(t("common.conversations", { count: 0 })).toBe("No conversations");
    expect(t("common.conversations", { count: 1 })).toBe("1 conversation");
  });

  it("falls back to English for a key the locale lacks, and to the key itself", () => {
    const { ["common.cancel"]: _, ...partial } = es;
    setLocale("es", partial as Messages);
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("common.close")).toBe("Cerrar");
    expect(t("nope.missing" as "common.cancel")).toBe("nope.missing");
  });

  it("shows a missing value as its placeholder instead of throwing", () => {
    expect(t("language.system", {} as { language: string })).toBe("System ({language})");
  });

});

describe("descriptors", () => {
  it("L() carries the key and params with the English text, whatever the active locale", () => {
    setLocale("es", es);
    expect(L("language.system", { language: "X" })).toEqual({ key: "language.system", params: { language: "X" }, message: "System (X)" });
    expect(L("common.conversations", { count: 1200 }).message).toBe("1,200 conversations");
    expect(L("common.cancel")).toEqual({ key: "common.cancel", message: "Cancel" });
  });

  it("translate() renders a descriptor in the active locale; an unknown key keeps its message", () => {
    setLocale("es", es);
    expect(translate(L("language.system", { language: "X" }))).toBe("Sistema (X)");
    expect(translate({ key: "gone.key", message: "Something" })).toBe("Something");
  });

  it("a keyRef param is rendered in the language of the message it fills", () => {
    const d = L("language.system", { language: keyRef("view.inbox") });
    expect(d.message).toBe("System (Inbox)");
    expect(plainText(keyRef("view.inbox"))).toBe("Inbox");
    expect(plainText("Plain")).toBe("Plain");
    setLocale("es", es);
    expect(translate(d)).toBe("Sistema (Entrada)");
    expect(t("language.system", { language: keyRef("view.trash") })).toBe("Sistema (Papelera)");
  });

  it("refText() shows a keyRef that came on its own (a model's label) in the active locale, other text as is", () => {
    expect(refText(keyRef("ai.model.demo"))).toBe("Demo model");
    expect(refText("llama3.1:8b")).toBe("llama3.1:8b");
    expect(refText("GPT-4o mini")).toBe("GPT-4o mini");
    setLocale("es", es);
    expect(refText(keyRef("ai.model.demo"))).toBe("Modelo de demostración");
    expect(refText(keyRef("ai.choice.compatible"))).toBe("Compatible con OpenAI");
  });

  it("isLocalized() checks shape, never trusts it", () => {
    expect(isLocalized({ key: "common.cancel" })).toBe(true);
    expect(isLocalized({ key: "a", params: { n: 1, s: "x" } })).toBe(true);
    expect(isLocalized({ key: 1 })).toBe(false);
    expect(isLocalized({ key: "a", params: { o: {} } })).toBe(false);
    expect(isLocalized("text")).toBe(false);
    expect(isLocalized(null)).toBe(false);
  });
});

describe("rich", () => {
  it("renders tags through their callbacks, text around them merged", () => {
    const parts = compile("Hi <b>{name}</b>, see <link>the docs</link>.");
    const out = renderRich<{ el: string; text: string }>(parts, { name: "Ana", b: (c: string) => ({ el: "b", text: c }), link: (c: string) => ({ el: "a", text: c }) }, String);
    expect(out).toEqual(["Hi ", { el: "b", text: "Ana" }, ", see ", { el: "a", text: "the docs" }, "."]);
  });

  it("keeps a tag without a renderer as text, and never parses tags out of values", () => {
    const parts = compile("From {name} <b>now</b>");
    expect(renderRich(parts, { name: "<b>Eve</b>" }, String)).toEqual(["From <b>Eve</b> now"]);
    expect(renderText(parts, { name: "x" }, String)).toBe("From x now");
  });

  it("goes through the catalog", () => {
    setLocale("en", { ...en, "language.hint": "Use <b>{x}</b>" } as Messages);
    expect(rich("language.hint" as never, { x: "it", b: (c: string) => c.toUpperCase() } as never)).toEqual(["Use ", "IT"]);
  });
});

describe("locales", () => {
  it("resolves System to a language Terno has, else English; an explicit choice wins", () => {
    expect(resolveLocale("system", ["es-MX"])).toBe("es");
    expect(resolveLocale("system", ["fr-FR", "es"])).toBe("es");
    expect(resolveLocale("system", ["es_ES"])).toBe("es");
    expect(resolveLocale("system", ["fr"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
    expect(resolveLocale("en", ["es-MX"])).toBe("en");
    expect(resolveLocale("es", ["en-US"])).toBe("es");
    expect(resolveLocale("klingon", ["es-MX"])).toBe("es");
  });

  it("loads a locale and tells listeners", async () => {
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    await loadLocale("es");
    off();
    expect(getLocale()).toBe("es");
    expect(seen).toEqual(["es"]);
    expect(t("common.cancel")).toBe("Cancelar");
  });

  it("formats numbers and lists for the active locale", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatList(["a", "b", "c"])).toBe("a, b, and c");
    setLocale("es", es);
    expect(formatNumber(1234567)).toBe("1,234,567"); // es-MX groups like today
    expect(formatList(["a", "b", "c"])).toBe("a, b y c");
  });

  it("every locale has exactly English's keys, kinds and placeholders (the type check, at runtime)", async () => {
    for (const id of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const catalog = await LOCALES[id].load();
      expect(Object.keys(catalog).sort(), id).toEqual(Object.keys(en).sort());
      for (const [key, message] of Object.entries(en)) {
        const other = catalog[key]!;
        expect(typeof other, `${id} ${key}`).toBe(typeof message);
        expect(placeholders(other), `${id} ${key}`).toEqual(placeholders(message));
        if (typeof other === "object") expect(other.other, `${id} ${key}`).toBeTruthy();
        else expect(other.trim(), `${id} ${key}`).not.toBe("");
      }
    }
  });

  it("errors that name a button quote its exact label, in both languages", () => {
    for (const catalog of [en, es] as Record<string, unknown>[]) {
      for (const kind of ["keychain", "legacy"]) {
        expect(catalog[`errors.secret.${kind}.password`]).toContain(`(${catalog["account.changePassword"]})`);
        expect(catalog[`errors.secret.${kind}.googleSession`]).toContain(`(${catalog["account.connectGoogle"]})`);
      }
    }
  });

  it("knows its keys", () => {
    expect(hasKey("common.cancel")).toBe(true);
    expect(hasKey("common.nope")).toBe(false);
  });
});

// ── type tests: `pnpm typecheck` fails if any of these compile
function typeTests() {
  // @ts-expect-error: unknown key
  t("common.nope");
  // @ts-expect-error: a placeholder is required
  t("language.system");
  // @ts-expect-error: wrong placeholder name
  t("language.system", { lang: "x" });
  // @ts-expect-error: a plural's count is a number
  t("common.conversations", { count: "3" });
  // @ts-expect-error: no params on a plain message
  t("common.cancel", { x: 1 });
  t("common.conversations", { count: 3 });

  type Es = typeof es;
  // a missing key
  type Missing = Omit<Es, "common.cancel">;
  // @ts-expect-error: "common.cancel" is missing
  ({}) as Missing satisfies LocaleCheck<Missing>;
  // an extra key
  type Extra = Es & { readonly "common.extra": "x" };
  // @ts-expect-error: "common.extra" isn't in English
  ({}) as Extra satisfies LocaleCheck<Extra>;
  // a renamed placeholder
  type Renamed = Omit<Es, "language.system"> & { readonly "language.system": "Sistema ({idioma})" };
  // @ts-expect-error: {language} became {idioma}
  ({}) as Renamed satisfies LocaleCheck<Renamed>;
  // a plural turned into a string
  type Flat = Omit<Es, "common.conversations"> & { readonly "common.conversations": "# conversaciones" };
  // @ts-expect-error: English has a plural here
  ({}) as Flat satisfies LocaleCheck<Flat>;
  // the real file passes
  es satisfies LocaleCheck<Es>;
}
void typeTests;

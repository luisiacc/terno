import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { carriedText } from "./carry";

afterEach(() => setLocale("en", en));

const result = (o: { categories?: number; filters?: number; drafts?: number; pendingDrafts?: number; pendingFilters?: number } = {}) => ({
  categories: { added: o.categories ?? 0, merged: 0 },
  filters: { added: o.filters ?? 0, existing: 0, skipped: [] },
  drafts: o.drafts ?? 0,
  pending: { drafts: o.pendingDrafts ?? 0, filters: o.pendingFilters ?? 0 },
});

describe("carriedText", () => {
  it("lists what came over, each count in its plural, drafts only when there were some", () => {
    expect(carriedText(result({ categories: 3, filters: 1 }))).toEqual({ message: "Brought over from your other storage: 3 categories, 1 filter, and your settings." });
    expect(carriedText(result({ categories: 1, filters: 2, drafts: 1 })).message).toBe("Brought over from your other storage: 1 category, 2 filters, 1 draft, and your settings.");
  });

  it("counts merged categories and existing filters too", () => {
    const r = { ...result(), categories: { added: 1, merged: 2 }, filters: { added: 0, existing: 4, skipped: [] } };
    expect(carriedText(r).message).toBe("Brought over from your other storage: 3 categories, 4 filters, and your settings.");
  });

  it("says what waits for its account, naming only what there is", () => {
    expect(carriedText(result({ pendingDrafts: 2, pendingFilters: 1 })).description).toBe("2 drafts and 1 filter from your accounts come back as soon as you connect them.");
    expect(carriedText(result({ pendingFilters: 3 })).description).toBe("3 filters from your accounts come back as soon as you connect them.");
    expect(carriedText(result()).description).toBeUndefined();
  });

  it("Spanish keeps today's wording", () => {
    setLocale("es", es);
    expect(carriedText(result({ categories: 3, filters: 1, drafts: 2, pendingDrafts: 1, pendingFilters: 2 }))).toEqual({
      message: "Traído de tu otro almacenamiento: 3 categorías, 1 filtro, 2 borradores y tus ajustes.",
      description: "1 borrador y 2 filtros de tus cuentas vuelven en cuanto las conectes.",
    });
  });
});

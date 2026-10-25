import type { ImportResult } from "@terno/core/rpc";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn() } }));
vi.mock("~/state/app", () => ({ setApp: vi.fn() }));
vi.mock("./appearance", () => ({ adoptSettings: vi.fn() }));
vi.mock("./drafts", () => ({ loadDrafts: vi.fn() }));

const { importSummary, importFile } = await import("./backup");

const result = (o: { categories?: number; filters?: number; skipped?: string[]; drafts?: number; settings?: boolean; pending?: ImportResult["pending"] } = {}): ImportResult => ({
  categories: { added: o.categories ?? 0, merged: 0 },
  filters: { added: o.filters ?? 0, existing: 0, skipped: o.skipped ?? [] },
  drafts: o.drafts ?? 0,
  pending: o.pending ?? { drafts: 0, filters: 0 },
  settings: o.settings ?? false,
});

describe("import summary", () => {
  afterEach(() => setLocale("en", en));

  it("counts what came in, one and many", () => {
    expect(importSummary(result({ categories: 1 }))).toBe("Imported: 1 new category and 0 filters.");
    expect(importSummary(result({ categories: 2, filters: 1, drafts: 3, settings: true }))).toBe("Imported: 2 new categories, 1 filter, 3 drafts, and your settings.");
  });

  it("says what waits for its account and what was left out", () => {
    expect(importSummary(result({ pending: { drafts: 1, filters: 2 }, skipped: ["Uber", "Bancos"] }))).toBe(
      "Imported: 0 new categories and 0 filters. 1 draft and 2 filters will come in when you connect their accounts. Not imported (their category isn’t in the file): Uber and Bancos.",
    );
  });

  it("in Spanish, with the wording it always had", () => {
    setLocale("es", es);
    expect(importSummary(result({ categories: 1, drafts: 2, settings: true, pending: { drafts: 2, filters: 1 } }))).toBe(
      "Importado: 1 categoría nueva, 0 filtros, 2 borradores y tus ajustes. 2 borradores y 1 filtro entran cuando conectes sus cuentas.",
    );
  });
});

describe("import file", () => {
  afterEach(() => setLocale("en", en));

  const file = (text: string, size = text.length) => ({ size, text: async () => text }) as unknown as File;

  it("refuses what isn't a Terno export, in the current language", async () => {
    await expect(importFile(file("{"))).rejects.toThrow("The file isn’t valid JSON.");
    await expect(importFile(file('{"format":"other"}'))).rejects.toThrow("This isn’t a Terno export.");
    await expect(importFile(file("{}", 51 * 2 ** 20))).rejects.toThrow("The file is too large (max. 50 MB).");
    setLocale("es", es);
    await expect(importFile(file('{"format":"other"}'))).rejects.toThrow("No es una exportación de Terno.");
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { setLocale, t } from "./index";
import en from "./locales/en";
import es from "./locales/es";

afterAll(() => setLocale("en", en));

/** t() runs during render for every label: a warm call must stay a lookup plus a short walk. */
describe("t() cost", () => {
  for (const [id, catalog] of [["en", en], ["es", es]] as const) {
    it(`${id}: plain ≤ 0.5 µs, plural with a formatted count ≤ 2 µs (p50 of 20 runs)`, () => {
      setLocale(id, catalog);
      const time = (f: (i: number) => void) => {
        const runs: number[] = [];
        for (let r = 0; r < 20; r++) {
          const start = performance.now();
          for (let i = 0; i < 20_000; i++) f(i);
          runs.push(((performance.now() - start) / 20_000) * 1000);
        }
        return runs.sort((a, b) => a - b)[10]!;
      };
      const plain = time(() => t("common.cancel"));
      const plural = time((i) => t("common.conversations", { count: i }));
      console.log(`[i18n] ${id} t(): plain ${plain.toFixed(3)} µs, plural ${plural.toFixed(3)} µs`);
      expect(plain).toBeLessThan(0.5);
      expect(plural).toBeLessThan(2);
    });
  }
});

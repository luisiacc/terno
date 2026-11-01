import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { sampleMailbox } from "./first-run-sample";

afterEach(() => setLocale("en", en));

describe("the first-run sample mailbox (plan 98)", () => {
  it("negative, unique ids (no store can match one), dated in the past, newest first", () => {
    const now = Date.UTC(2026, 9, 31, 12);
    const { threads, categories, open } = sampleMailbox(now);
    const ids = threads.map((x) => x.id);
    expect(ids.every((id) => id < 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(categories.every((c) => c.id < 0)).toBe(true);
    expect(threads.every((x) => x.lastDate < now)).toBe(true);
    expect(threads.map((x) => x.lastDate)).toEqual(threads.map((x) => x.lastDate).sort((a, b) => b - a));
    // every category a thread names is one the preview has
    expect(threads.flatMap((x) => x.categoryIds).every((id) => categories.some((c) => c.id === id))).toBe(true);
    expect(open.thread).toBe(threads[0]);
  });

  it("is written in the user's language", () => {
    expect(sampleMailbox().open.thread.subject).toBe("Dinner on Friday?");
    setLocale("es", es);
    const { threads, categories, open } = sampleMailbox();
    expect(open.thread.subject).toBe("¿Cenamos el viernes?");
    expect(open.body).toContain("Reservo mesa para seis.");
    expect(categories.map((c) => c.name)).toEqual(["Viajes", "Trabajo"]);
    for (const x of threads) for (const text of [x.subject, x.snippet, x.fromName]) expect(text).not.toMatch(/^firstRun\./);
  });
});

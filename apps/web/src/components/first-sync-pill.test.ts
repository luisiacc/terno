import { afterEach, describe, expect, it } from "vitest";
import { loadLocale } from "@terno/i18n";
import { syncLeft } from "./first-sync-pill";

// Plan 103: what the sync card says is left, per account.
const DAY = 86_400_000;
afterEach(async () => { await loadLocale("en"); });

describe("syncLeft", () => {
  it("messages left of an estimate, folders left, days left, finishing, starting", async () => {
    await loadLocale("en");
    expect(syncLeft({ done: 1200, total: 5521, unit: "messages" }, 0)).toEqual({ label: "About 4,321 messages left", short: "~4,321 left", fraction: 1200 / 5521 });
    expect(syncLeft({ done: 4, total: 7, unit: "folders" }, 0)).toMatchObject({ short: "3 folders left" });
    const now = Date.now();
    expect(syncLeft({ reachedAt: now - 300 * DAY }, now - 365 * DAY)).toMatchObject({ short: "65 days left" });
    expect(syncLeft({ finishing: true }, 0)).toMatchObject({ short: "Finishing up", fraction: 1 });
    expect(syncLeft(null, 0)).toEqual({ label: "Starting", short: "Starting", fraction: null });
  });

  it("numbers in Terno's language, not the system's (Codex review)", async () => {
    await loadLocale("es");
    // Terno's Spanish is es-MX (its own grouping), whatever the system's locale
    expect(syncLeft({ done: 1200, total: 5521, unit: "messages" }, 0).short).toBe(`Quedan ~${new Intl.NumberFormat("es-MX").format(4321)}`);
    expect(syncLeft({ done: 1200, total: 5521, unit: "messages" }, 0).label).toBe("Quedan cerca de 4,321 mensajes");
  });
});

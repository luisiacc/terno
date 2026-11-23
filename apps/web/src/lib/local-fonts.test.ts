import { afterEach, describe, expect, it, vi } from "vitest";
import { familiesFrom, installedFamilies, resetInstalledFamilies } from "./local-fonts";

const g = globalThis as { queryLocalFonts?: unknown };

afterEach(() => {
  delete g.queryLocalFonts;
  resetInstalledFamilies();
});

describe("the computer's font families (plan 248)", () => {
  it("each once, A–Z whatever the case; hidden, unplain and Terno's own names left out", () => {
    const faces = ["Menlo", "avenir next", "Menlo", ".SF NS", "Georgia", 'Bad"Name', "Inter", "geist", "Ágora", "Zapfino"].map((family) => ({ family }));
    expect(familiesFrom(faces)).toEqual(["Ágora", "avenir next", "Georgia", "Menlo", "Zapfino"]);
  });

  it("are read once, when first asked", async () => {
    const query = vi.fn(async () => [{ family: "Georgia" }]);
    g.queryLocalFonts = query;
    expect(query).not.toHaveBeenCalled();
    expect(await installedFamilies()).toEqual(["Georgia"]);
    expect(await installedFamilies()).toEqual(["Georgia"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("are null where the browser has no list or refuses one, and a refusal is asked again next time", async () => {
    expect(await installedFamilies()).toBeNull();
    const query = vi.fn().mockRejectedValueOnce(new DOMException("denied", "NotAllowedError")).mockResolvedValueOnce([{ family: "Menlo" }]);
    g.queryLocalFonts = query;
    resetInstalledFamilies();
    expect(await installedFamilies()).toBeNull();
    await Promise.resolve();
    expect(await installedFamilies()).toEqual(["Menlo"]);
  });
});

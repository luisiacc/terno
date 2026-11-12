import { describe, expect, it } from "vitest";
import { releaseNotesUrl, TERNO_LINKS } from "./terno-links";

describe("Terno's public pages (plan 190)", () => {
  it("a release's notes are its tag; a build that isn't a release gets the list", () => {
    expect(releaseNotesUrl("0.2.0")).toBe("https://github.com/luisiacc/terno/releases/tag/v0.2.0");
    expect(releaseNotesUrl("0.2.0-nightly.3", "642c1b3290")).toBe("https://github.com/luisiacc/terno/releases/tag/v0.2.0-nightly.3");
    for (const [v, sha] of [["0.2.0", "dev"], ["0.0.0", "abc1234"], ["bogus", undefined]] as const) expect(releaseNotesUrl(v, sha)).toBe(TERNO_LINKS.releases);
  });

  it("are all https pages of the public repository", () => {
    for (const url of Object.values(TERNO_LINKS)) expect(url).toMatch(/^https:\/\/github\.com\/luisiacc\/terno(\/|$)/);
  });
});

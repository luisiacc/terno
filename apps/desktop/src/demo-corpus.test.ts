import { describe, expect, it } from "vitest";
import { takeDemoCorpus } from "./demo-corpus";

describe("plan 292: the written demo mailbox reaches only a dev build's demo", () => {
  it("takes the folder out of main's environment whatever happens, so the backend never inherits it", () => {
    for (const [demo, packaged] of [[true, false], [true, true], [false, false]] as const) {
      const env: Record<string, string | undefined> = { TERNO_DEMO_CORPUS: "/repo/packages/mock-data/demo-corpus", PATH: "/bin" };
      takeDemoCorpus(env, demo, packaged);
      expect(env).toEqual({ PATH: "/bin" });
    }
  });

  it("hands the folder on only with the demo mailbox in an unpackaged build (revision 1)", () => {
    const env = () => ({ TERNO_DEMO_CORPUS: "/c" });
    expect(takeDemoCorpus(env(), true, false)).toBe("/c");
    expect(takeDemoCorpus(env(), true, true)).toBeNull();
    expect(takeDemoCorpus(env(), false, false)).toBeNull();
    expect(takeDemoCorpus({}, true, false)).toBeNull();
  });
});

import { expect, it } from "vitest";
import { registerMailReaderBack, returnFromMailReaderView } from "../../src/components/mail-reader-back";
it("retiring an old page cannot remove the current Back owner", () => {
  const calls: string[] = [];
  const old = registerMailReaderBack(() => calls.push("old"));
  const current = registerMailReaderBack(() => calls.push("current"));
  try {
    old();
    expect(returnFromMailReaderView()).toBe(true);
    expect(calls).toEqual(["current"]);
  } finally { current(); }
  expect(returnFromMailReaderView()).toBe(false);
});

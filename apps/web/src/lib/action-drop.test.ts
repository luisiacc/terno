/** Plan 178: what a drop on Starred, Archive, Spam or Trash does, decided from the dragged rows. */
import { describe, expect, it } from "vitest";
import { folderRef } from "@terno/core";
import { actionDropState, actionFacts, actionRef, actionRefusal, parseActionRef } from "./action-drop";

const row = (id: number, place: "inbox" | "archive" | "spam" | "trash" | "unknown", o: { starred?: boolean; accountId?: number; hasSpam?: boolean } = {}) => ({
  id,
  accountId: o.accountId ?? 1,
  starred: o.starred ?? false,
  inInbox: place === "unknown" ? undefined : place === "inbox",
  inSpam: place === "unknown" ? undefined : place === "spam",
  inTrash: place === "unknown" ? undefined : place === "trash",
  hasSpam: o.hasSpam ?? place === "spam",
});
const all = (view: "starred" | "archive" | "spam" | "trash") => ({ view, accountId: null });

describe("action refs", () => {
  it("round-trips, for every account and for one", () => {
    expect(parseActionRef(actionRef("archive"))).toEqual({ view: "archive", accountId: null });
    expect(parseActionRef(actionRef("trash", 3))).toEqual({ view: "trash", accountId: 3 });
  });

  it("a folder called archive, or a view that takes no drop, is not one", () => {
    expect(parseActionRef(folderRef(3, "archive"))).toBeNull();
    expect(parseActionRef("view:inbox")).toBeNull();
    expect(parseActionRef("view:archive:")).toBeNull();
    expect(parseActionRef("view:archive:x")).toBeNull();
    expect(parseActionRef("view:archive:3:4")).toBeNull();
    expect(parseActionRef("view:constructor")).toBeNull();
  });
});

describe("a drop's state", () => {
  it("each place takes the rows its action changes", () => {
    const f = actionFacts([row(1, "inbox"), row(2, "archive", { starred: true }), row(3, "spam"), row(4, "trash")]);
    // Spam takes what's in Trash too, as the Trash's own menu does
    expect(f.fits).toEqual({ starred: [1, 3, 4], archive: [1], spam: [1, 2, 4], trash: [1, 2, 3] });
    for (const v of ["starred", "archive", "spam", "trash"] as const) expect(actionDropState(f, all(v))).toBe("over");
  });

  it("everything already there is ✓", () => {
    expect(actionDropState(actionFacts([row(1, "inbox", { starred: true }), row(2, "trash", { starred: true })]), all("starred"))).toBe("already");
    expect(actionDropState(actionFacts([row(1, "archive"), row(2, "archive")]), all("archive"))).toBe("already");
    expect(actionDropState(actionFacts([row(1, "spam")]), all("spam"))).toBe("already");
    expect(actionDropState(actionFacts([row(1, "trash")]), all("trash"))).toBe("already");
  });

  it("nothing it can do, but not all there: refused, and says why", () => {
    // Archive takes mail out of the Inbox only
    const archive = actionFacts([row(1, "trash"), row(2, "archive")]);
    expect(actionDropState(archive, all("archive"))).toBe("refused");
    expect(actionRefusal(archive, all("archive"))).toMatch(/Inbox/);
    // narrowed as the action's button would be: a search's Spam skips what's in Trash (plan 64)
    const spam = actionFacts([row(1, "trash")], (action, ids) => (action === "spam" ? [] : ids));
    expect(actionDropState(spam, all("spam"))).toBe("refused");
    expect(actionRefusal(spam, all("spam"))).toMatch(/Trash/);
    expect(actionDropState(actionFacts([row(1, "trash")]), all("spam"))).toBe("over");
  });

  it("Codex review: spam already in Trash is ✓ on Spam (marking it again would change nothing, and take Undo's place)", () => {
    expect(actionDropState(actionFacts([row(1, "trash", { hasSpam: true })]), all("spam"))).toBe("already");
    expect(actionFacts([row(1, "trash", { hasSpam: true }), row(2, "trash")]).fits.spam).toEqual([2]);
  });

  it("Codex review: an archived row on the Inbox's top for a due reminder fits Archive (its button ends the reminder)", () => {
    const f = actionFacts([row(1, "archive"), row(2, "archive")], undefined, (id) => id === 1);
    expect(f.fits.archive).toEqual([1]);
    expect(actionDropState(f, all("archive"))).toBe("over");
    expect(actionDropState(actionFacts([row(1, "archive")]), all("archive"))).toBe("already");
  });

  it("an account's place takes that account's mail only", () => {
    const one = actionFacts([row(1, "inbox", { accountId: 2 })]);
    expect(actionDropState(one, { view: "trash", accountId: 2 })).toBe("over");
    expect(actionDropState(one, { view: "trash", accountId: 3 })).toBe("refused");
    expect(actionRefusal(one, { view: "trash", accountId: 3 })).toMatch(/another account/);
    const mixed = actionFacts([row(1, "inbox", { accountId: 2 }), row(2, "inbox", { accountId: 3 })]);
    expect(actionDropState(mixed, { view: "archive", accountId: 2 })).toBe("refused");
    expect(actionDropState(mixed, all("archive"))).toBe("over");
  });

  it("a row whose place isn't known fits everything: the backend decides", () => {
    const f = actionFacts([row(1, "unknown"), row(2, "archive")]);
    expect(f.fits.archive).toEqual([1]);
    expect(f.already.archive).toBe(false);
    expect(actionDropState(f, all("archive"))).toBe("over");
  });
});

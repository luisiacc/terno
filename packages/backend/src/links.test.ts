import { describe, expect, it } from "vitest";
import { linksOf, resolveLink } from "./links";

type Copy = { id: number; threadId: number; accountId: number; spam: boolean; trash: boolean };
const store = (copies: Copy[], refs: Record<number, string> = {}) => ({
  links: { find: async () => copies, newest: async (ids: readonly number[]) => new Map(ids.filter((i) => i < 10).map((i) => [i, `t${i}@x`])) },
  drafts: { messageRef: async (id: number) => refs[id] ?? null },
});
const copy = (id: number, o: Partial<Copy> = {}): Copy => ({ id, threadId: id * 10, accountId: 1, spam: false, trash: false, ...o });

describe("which copy a link opens (plan 201)", () => {
  it("the first stored outside Spam and Trash; a later copy (a reused Message-ID) never takes over", async () => {
    expect(await resolveLink(store([copy(1, { spam: true }), copy(2), copy(3)]) as never, "a@b")).toEqual({ threadId: 20, messageId: 2 });
  });

  it("all in Spam or Trash: the first stored; none: null", async () => {
    expect(await resolveLink(store([copy(4, { trash: true }), copy(5, { spam: true })]) as never, "a@b")).toEqual({ threadId: 40, messageId: 4 });
    expect(await resolveLink(store([]) as never, "a@b")).toBeNull();
  });

  it("the ids for the MCP: conversations and messages, those without one left out", async () => {
    expect(await linksOf(store([], { 5: "m5@x" }) as never, { threadIds: [1, 20], messageIds: [5, 6, 5] })).toEqual({ threads: { 1: "t1@x" }, messages: { 5: "m5@x" } });
  });
});

import { describe, expect, it } from "vitest";
import { passageOf, readPassages, type AskPassageIo } from "./ask";

const io = (ids: number[]): AskPassageIo =>
  ({
    matching: async () => ({ ids: ids.map((id) => ({ id, threadId: 1 })), incomplete: false }),
    newest: async () => new Map([[1, ids[0]!]]),
    headers: async (chosen: readonly number[]) => new Map(chosen.map((id) => [id, { id, threadId: 1, accountId: 1, fromName: "A", fromEmail: "a@x.test", subject: "s", snippet: "s", date: id, own: false, spam: false, trash: false, draft: false, bodyState: "full", bodyUnavailable: false }])),
    text: async () => "lease ".repeat(2000),
  }) as unknown as AskPassageIo;

const request = (maxChars: number) => ({ threadIds: [1], queries: [{ query: { terms: [{ field: "text", value: "lease" }], anyOf: [] } }] as never, maxMessages: 40, maxChars });

describe("what a page of passages left out (plan 141)", () => {
  it("is nothing when it read them all", async () => {
    expect((await readPassages(request(1_000_000), io([3, 2, 1]))).omitted).toBe(false);
  });
  it("counts what the per-thread limit left", async () => {
    expect((await readPassages(request(1_000_000), io([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]))).omitted).toBe(true);
  });
  it("counts what the character budget left, though it was chosen", async () => {
    const r = await readPassages(request(10), io([3, 2, 1]));
    expect(r.messages.length).toBeLessThan(3);
    expect(r.omitted).toBe(true);
  });
});

describe("plan 158: a phrase is found as search finds it", () => {
  it("whatever lies between its words: punctuation, a line break, more than one space", () => {
    const filler = "palabras de relleno ".repeat(60);
    for (const between of [": ", "\n", "   "]) expect(passageOf(`${filler}the door${between}code is 4921`, ["door code"])).toContain("4921");
  });
});

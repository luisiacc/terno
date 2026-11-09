import { describe, expect, it, vi } from "vitest";

const openRow = vi.fn(async () => {});
const setInstruction = vi.fn();
const rowKeyOf = vi.fn(() => "draft-1");
vi.mock("~/lib/ai-draft", () => ({ openRow, setInstruction, rowKeyOf }));
vi.mock("~/lib/snack", () => ({ snack: { error: vi.fn() } }));
const { replyFromItem } = await import("./summary-reply");

describe("plan 162: a summary item's Reply drafts from it", () => {
  it("seeds the instruction only where the reply landed (Codex review): a cancelled open writes into no draft found afterwards", async () => {
    // the open was cancelled: it never landed, so nothing is seeded, though a draft for the conversation exists
    await replyFromItem(4, "  Tell Arjun what you think ");
    expect(openRow).toHaveBeenCalledWith({ threadId: 4, instruction: "Tell Arjun what you think" });
    expect(setInstruction).not.toHaveBeenCalled();
    expect(rowKeyOf).not.toHaveBeenCalled();
  });
});

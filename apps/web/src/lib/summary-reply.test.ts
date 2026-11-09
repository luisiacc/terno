import { describe, expect, it, vi } from "vitest";

const reply = vi.fn();
const openRow = vi.fn();
vi.mock("~/lib/keyboard", () => ({ reply }));
vi.mock("~/lib/ai-draft", () => ({ openRow }));
const { replyFromItem } = await import("./summary-reply");

describe("plan 162 (after ai162-r03): a summary item's Reply", () => {
  it("is the ordinary reply, as R is: nothing goes into ⌘J as the instruction", () => {
    replyFromItem();
    expect(reply).toHaveBeenCalledWith("reply");
    expect(openRow).not.toHaveBeenCalled();
  });
});

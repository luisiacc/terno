// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const { askErrorCopy } = await import("./ask-page");
const { hasAddress } = await import("./ai-error");

describe("plan 162: Ask says its failures in the one AI error's words (Codex review)", () => {
  it("no credit left is said as the app's own sentence, not as a key the provider refused", () => {
    const copy = askErrorCopy({ message: "Anthropic says this account has no credit left. Add credit with Anthropic, or choose another provider in Settings → AI.", kind: "auth", key: "errors.ai.noCredit" }, null);
    expect(copy.title).toMatch(/no credit left/);
    expect(copy.title).not.toMatch(/API key/);
  });
  it("a provider's message with its address is said by its kind", () => {
    const copy = askErrorCopy({ message: "Couldn’t find Ollama at 127.0.0.1:60512. Is it open?", kind: "unavailable" }, null);
    expect(hasAddress(`${copy.title} ${copy.help ?? ""}`)).toBe(false);
  });
});

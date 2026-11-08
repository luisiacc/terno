// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const call = vi.fn(async (method: string, ..._a: unknown[]): Promise<unknown> => {
  if (method === "ai.actionCheck") throw Object.assign(new Error("Couldn’t find Ollama at 127.0.0.1:60512. Is it open?"), { details: { aiErrorKind: "unavailable" } });
  return { items: [], nextCursor: null, total: 0, unticked: [] };
});
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));
const { check } = await import("./action-preview");
const { useActionPreview } = await import("~/state/action-preview");
const { setApp } = await import("~/state/app");
const { aiErrorCopy, hasAddress } = await import("~/components/ai-error");

describe("plan 162: the action check's failure keeps what it was (Codex review)", () => {
  it("its kind goes with it, so the notice says it by kind and never with the provider's address", async () => {
    useActionPreview.setState({ preview: { previewId: "p1" } as never });
    setApp({ actionPreview: "p1" });
    await check({});
    const error = useActionPreview.getState().checkError!;
    expect(error.kind).toBe("unavailable");
    const copy = aiErrorCopy(error, null);
    expect(hasAddress(`${copy.title} ${copy.help ?? ""}`)).toBe(false);
  });
});

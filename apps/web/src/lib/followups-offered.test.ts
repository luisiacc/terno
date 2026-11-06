// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

const call = vi.fn(async (): Promise<unknown> => ({ ok: true }));
vi.mock("~/rpc/connection", () => ({ client: { call, on: () => () => {}, connectionVersion: 1 } }));

const handlers: { opened: (id: number) => unknown; settled: (id: number) => void }[] = [];
vi.mock("~/lib/open-dwell", () => ({ onExplicitOpen: (h: (typeof handlers)[number]) => handlers.push(h), noteExplicitOpen: () => {} }));

await import("./followups");
const { setApp } = await import("~/state/app");
const { useFollowups } = await import("~/state/followups");

const handler = handlers.at(-1)!;
const keys = { anthropic: true, openai: false, jev: false };
const enabled = (devAi: boolean) => ({ followups: { enabled: true }, devAi }) as never;

describe("a follow-up that's hidden isn't seen (plan 147)", () => {
  beforeEach(() => {
    call.mockClear();
    useFollowups.setState({ byThread: new Map([[7, [{ inboxState: "onTop" }]]]) } as never);
  });

  it("Dev mode's switch off: opening the thread leaves it on the Inbox's top for when it shows again", () => {
    setApp({ devAi: keys, settings: enabled(false) });
    expect(handler.opened(7)).toBeFalsy();
  });

  it("showing, opening it is what ends the row", () => {
    setApp({ devAi: keys, settings: enabled(true) });
    expect(handler.opened(7)).toBe(true);
    setApp({ devAi: null, settings: enabled(false) });
    expect(handler.opened(7)).toBe(true);
  });
});

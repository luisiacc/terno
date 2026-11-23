// @vitest-environment jsdom
import type { AppSettings } from "@terno/core/rpc";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";
import { WhatMattersTab } from "./what-matters-tab";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

const settings = (today: Partial<NonNullable<AppSettings["today"]>> = {}) =>
  ({
    today: { show: true, finished: true, digest: false, notify: false, prepareAt: "08:00", ...today },
    dated: { enabled: true, enabledAt: null },
    firstScreen: "inbox",
    keepInboxCount: false,
    devAi: false,
    ai: { provider: "anthropic", model: "claude-sonnet-5-5", local: false, hasKey: true, keyConfirmed: true, keyUnreadable: false, keys: { anthropic: { hasKey: true, keyHint: null } }, profiles: {}, monthlyLimitUsd: 20 },
  }) as unknown as AppSettings;

const account = (id: number, displayName: string, email: string) => ({ id, displayName, email, feed: true, ai: true, kind: "gmail" });
const byId = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const describedBy = (host: HTMLElement, el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => host.querySelector(`[id="${id}"]`)?.textContent ?? "").join(" ");

describe("plan 247: Settings → What matters", () => {
  beforeEach(() => {
    vi.mocked(client.call).mockImplementation((async (method: string) => (method === "today.notNewsletters" || method === "today.shownSenders" ? { senders: [] } : method === "dated.mutes" ? { mutes: [] } : method === "dated.status" ? { blockedBy: null } : {})) as never);
    useApp.setState({ devAi: null, settings: settings(), accounts: [account(1, "Work", "me@work.test")] } as never);
  });

  it("goes by what you can do: the view, what it looks for, shown and hidden, each morning", async () => {
    const s = settings();
    const host = await render(<WhatMattersTab settings={s} update={vi.fn() as never} />);
    const titles = [...host.querySelectorAll("section > h3")].map((h) => h.textContent);
    expect(titles).toEqual(["What it looks for", "Shown and hidden", "Each morning"]);
    expect(byId(host, "wm-settings-view")!.textContent).toMatch(/^Show in the sidebar.*Open at launch.*Show finished items/);
    // the reader says who reads its mail beside its switch, and in full under its group
    const finds = byId(host, "ai-dated")!;
    expect(finds.textContent).toContain("Read by Claude (Anthropic).");
    expect(byId(host, "today-privacy")!.textContent).toMatch(/^Privacy\. To find bills, trips and requests, Terno sends each new message/);
    // the digest names where its mail goes
    expect(byId(host, "ai-digest")!.textContent).toContain("to Claude (Anthropic)");
  });

  it("asks for a time only for what comes then: off with both off, saying why; on with either", async () => {
    const host = await render(<WhatMattersTab settings={settings()} update={vi.fn() as never} />);
    const field = byId(host, "today-time-row")!.querySelector("[role=group]")!;
    expect(byId(host, "today-time-row")!.querySelector("[data-disabled]")).not.toBeNull();
    expect(describedBy(host, field)).toContain("Turn on the digest or the notification to choose a time.");
    cleanup?.();
    for (const on of [{ digest: true }, { notify: true }]) {
      const host2 = await render(<WhatMattersTab settings={settings(on)} update={vi.fn() as never} />);
      const row = byId(host2, "today-time-row")!;
      expect(row.querySelector("[data-disabled]"), JSON.stringify(on)).toBeNull();
      expect(describedBy(host2, row.querySelector("[role=group]")!)).toContain("When the digest is made and the notification comes.");
      cleanup?.();
    }
  });

  it("lists each account with its switch with two or more, which saves through the account; none with one", async () => {
    const host = await render(<WhatMattersTab settings={settings()} update={vi.fn() as never} />);
    expect(byId(host, "wm-settings-accounts")).toBeNull();
    cleanup?.();
    useApp.setState({ accounts: [account(1, "Work", "me@work.test"), { ...account(2, "Home", "me@home.test"), feed: false }] } as never);
    const host2 = await render(<WhatMattersTab settings={settings()} update={vi.fn() as never} />);
    const group = byId(host2, "wm-settings-accounts")!;
    expect([...group.querySelectorAll("[data-testid=wm-account]")].map((r) => r.textContent)).toEqual(["Workme@work.test", "Homeme@home.test"]);
    const switches = [...group.querySelectorAll<HTMLElement>("[data-testid=wm-account-feed]")];
    expect(switches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await act(async () => switches[1]!.click());
    expect(vi.mocked(client.call)).toHaveBeenCalledWith("accounts.update", { id: 2, feed: true });
  });

  it("offers Open at launch only while it's in the sidebar, and the Inbox's number only while it opens first", async () => {
    useApp.setState({ settings: settings({ show: false }) } as never);
    const host = await render(<WhatMattersTab settings={settings({ show: false })} update={vi.fn() as never} />);
    expect(byId(host, "today-show")!.getAttribute("aria-checked")).toBe("false");
    expect(byId(host, "first-screen-row")).toBeNull();
    cleanup?.();
    const first = { ...settings(), firstScreen: "whatMatters" } as AppSettings;
    useApp.setState({ settings: first } as never);
    const host2 = await render(<WhatMattersTab settings={first} update={vi.fn() as never} />);
    expect(byId(host2, "first-screen-row")).not.toBeNull();
    expect(byId(host2, "keep-inbox-count-row")).not.toBeNull();
  });
});

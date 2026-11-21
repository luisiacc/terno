// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// a client whose events and reattachments the test fires by hand
const rpc = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const attach = new Set<() => void>();
  return {
    call: vi.fn(async (_method: string) => []),
    on: (e: string, l: () => void) => {
      let set = listeners.get(e);
      if (!set) listeners.set(e, (set = new Set()));
      set.add(l);
      return () => set.delete(l);
    },
    onAttach: (l: () => void) => {
      attach.add(l);
      return () => attach.delete(l);
    },
    fire: (e: string) => listeners.get(e)?.forEach((l) => l()),
    reattach: () => attach.forEach((l) => l()),
  };
});
vi.mock("~/rpc/connection", () => ({ client: rpc }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("plan 234: the offer is asked for when counts really change, when the backend says so, and after a reconnect, not for the same numbers", async () => {
  const { LearnedSource } = await import("./learned-banner");
  const { EMPTY_COUNTS, publishCounts, setApp } = await import("~/state/app");
  setApp({ view: "inbox", query: "", counts: { ...EMPTY_COUNTS, inboxUnread: 2 } });
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<LearnedSource />));
  const asked = () => rpc.call.mock.calls.filter(([m]) => m === "learning.proposals").length;
  expect(asked()).toBe(1);
  // the backend's numbers again, a fresh object: nothing to ask
  await act(async () => publishCounts({ ...EMPTY_COUNTS, inboxUnread: 2 }));
  expect(asked()).toBe(1);
  await act(async () => publishCounts({ ...EMPTY_COUNTS, inboxUnread: 1 }));
  expect(asked()).toBe(2);
  // a read conversation archived: no count moves, the backend says the offers may have
  await act(async () => rpc.fire("learningChanged"));
  expect(asked()).toBe(3);
  // back from a lost connection, with the same counts: it may have missed that event
  await act(async () => rpc.reattach());
  expect(asked()).toBe(4);
  await act(async () => root.unmount());
  // unmounted: nothing listens any more
  rpc.fire("learningChanged");
  rpc.reattach();
  expect(asked()).toBe(4);
});

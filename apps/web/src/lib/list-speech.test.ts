// @vitest-environment jsdom
/** Plan 188: the list's news where focus isn't, said once and exactly. */
import type { ThreadSummary } from "@terno/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const said = vi.hoisted(() => [] as string[]);
vi.mock("~/lib/announce", () => ({ announce: (text: string) => void said.push(text) }));
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));
vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }));

const { installListSpeech } = await import("./list-speech");
const { useList } = await import("~/state/list");
const { setApp } = await import("~/state/app");

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }) as ThreadSummary);
let off = () => {};
beforeEach(() => {
  said.length = 0;
  document.body.innerHTML = `<aside id="app-sidebar"><button>Archive</button></aside><section id="app-list"><h1>Archive</h1></section><button id="elsewhere">x</button>`;
  useList.setState({ key: "inbox", itemsKey: "inbox", items: rows(3), loading: false, nextCursor: null });
  setApp({ checked: new Set(), scope: null });
  off = installListSpeech();
});
afterEach(() => off());

it("a mailbox opened from the sidebar says how many came once its own first page is in", () => {
  document.querySelector<HTMLElement>("#app-sidebar button")!.focus();
  useList.setState({ key: "archive", loading: true });
  // the old list's answer, or a page still on its way, says nothing
  useList.setState({ loading: false, itemsKey: "inbox" });
  expect(said).toEqual([]);
  useList.setState({ itemsKey: "archive", items: rows(50), nextCursor: { lastDate: 0, id: 50 } as never, loading: false });
  expect(said).toEqual(["Archive, more than 50 conversations"]);
  useList.setState({ items: rows(51) });
  expect(said).toHaveLength(1);
});

it("says the whole count when the list is all in, and when it's empty", () => {
  document.querySelector<HTMLElement>("#app-sidebar button")!.focus();
  useList.setState({ key: "a", loading: true });
  useList.setState({ key: "a", itemsKey: "a", items: rows(2), loading: false, nextCursor: null });
  useList.setState({ key: "b", loading: true });
  useList.setState({ key: "b", itemsKey: "b", items: [], loading: false });
  expect(said).toEqual(["Archive, 2 conversations", "No conversations in Archive"]);
});

it("a list that changes with focus elsewhere (a search typed, the list itself) says nothing", () => {
  document.getElementById("elsewhere")!.focus();
  useList.setState({ key: "search", loading: true });
  useList.setState({ itemsKey: "search", items: rows(4), loading: false });
  expect(said).toEqual([]);
});

it("the selection says its size as it changes, whatever changed it; Select all says its mailbox's count", () => {
  setApp({ checked: new Set([1]) });
  setApp({ checked: new Set([1, 2]) });
  setApp({ checked: new Set() });
  setApp({ scope: { key: "inbox", scope: {} as never, label: "Inbox", count: 240 } });
  expect(said).toEqual(["1 selected", "2 selected", "Selection cleared", "240 selected"]);
});

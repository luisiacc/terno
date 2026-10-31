/**
 * Plan 89 (Codex plan review 8): one save in flight per snippet, the latest
 * content winning; a failure keeps it; a conflict waits for the user; delete
 * waits for the save in flight, and its Undo puts back the same snippet.
 */
import type { Snippet } from "@terno/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const calls: Call[] = [];
vi.mock("~/rpc/connection", () => ({
  client: { call: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject })) },
}));
const { beginEdit, deleteSnippet, flushSave, keepMine, loadTheirs, queueSave, resetSnippetsForTests, retrySave, snippetsSaved, unsavedContent, useSaveStatus, useSnippets, useUnsaved, SAVE_DELAY_MS } = await import("./snippets");
const { useSnack, runUndo } = await import("./snack");

const fields = (name: string) => ({ name, bodyHtml: "", bodyText: name, subject: "", to: "", cc: "", bcc: "" });
const saved = (id: string, name: string, updatedAt: number): Snippet => ({ ...fields(name), id, createdAt: 1, updatedAt });
const flush = () => Promise.resolve();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  calls.length = 0;
  resetSnippetsForTests();
});
afterEach(() => vi.useRealTimers());

it("saves once after the last change, one at a time, the latest content winning", async () => {
  beginEdit("s_aaaaaaaa", null);
  queueSave("s_aaaaaaaa", fields("I"));
  queueSave("s_aaaaaaaa", fields("In"));
  vi.advanceTimersByTime(SAVE_DELAY_MS);
  expect(calls.map((c) => [c.params.name, c.params.base])).toEqual([["In", null]]);
  // typed while that save is out: waits for it, then goes on its result's version
  queueSave("s_aaaaaaaa", fields("Int"));
  queueSave("s_aaaaaaaa", fields("Intro"), true);
  expect(calls).toHaveLength(1);
  calls[0]!.resolve(saved("s_aaaaaaaa", "In", 100));
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect([calls[1]!.params.name, calls[1]!.params.base]).toEqual(["Intro", 100]);
  calls[1]!.resolve(saved("s_aaaaaaaa", "Intro", 101));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("saved"));
  expect(useSnippets.getState().list?.map((s) => s.name)).toEqual(["Intro"]);
});

it("leaving the editor saves what's waiting at once", () => {
  beginEdit("s_aaaaaaaa", 5);
  queueSave("s_aaaaaaaa", fields("x"));
  flushSave("s_aaaaaaaa");
  expect(calls.map((c) => c.params.base)).toEqual([5]);
});

it("keeps the content of a failed save for Retry", async () => {
  beginEdit("s_aaaaaaaa", 5);
  queueSave("s_aaaaaaaa", fields("kept"), true);
  calls[0]!.reject(new Error("disk full"));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("failed"));
  retrySave("s_aaaaaaaa");
  expect(calls.map((c) => c.params.name)).toEqual(["kept", "kept"]);
});

it("a conflict waits for the user; Keep mine saves over it", async () => {
  beginEdit("s_aaaaaaaa", 5);
  queueSave("s_aaaaaaaa", fields("mine"), true);
  calls[0]!.reject(Object.assign(new Error("changed"), { code: "STALE" }));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("conflict"));
  queueSave("s_aaaaaaaa", fields("mine 2"), true);
  expect(calls).toHaveLength(1);
  keepMine("s_aaaaaaaa");
  expect([calls[1]!.params.name, calls[1]!.params.force]).toEqual(["mine 2", true]);
});

it("delete waits for the save in flight, saves nothing more, and Undo restores the latest content under the same id", async () => {
  beginEdit("s_aaaaaaaa", 5);
  useSnippets.setState({ list: [saved("s_aaaaaaaa", "old", 5)] });
  queueSave("s_aaaaaaaa", fields("sent"), true);
  queueSave("s_aaaaaaaa", fields("typed"));
  const deleting = deleteSnippet(saved("s_aaaaaaaa", "old", 5));
  await flush();
  expect(calls.map((c) => c.method)).toEqual(["snippets.save"]);
  calls[0]!.resolve(saved("s_aaaaaaaa", "sent", 6));
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["snippets.save", "snippets.delete"]));
  calls[1]!.resolve({ ok: true });
  await deleting;
  vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
  expect(calls).toHaveLength(2);
  expect(useSnippets.getState().list).toEqual([]);
  const undo = useSnack.getState().undo!;
  const undone = runUndo(undo);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]!.params).toMatchObject({ id: "s_aaaaaaaa", name: "typed", base: null });
  calls[2]!.resolve(saved("s_aaaaaaaa", "typed", 7));
  await undone;
  expect(useSnippets.getState().list?.map((s) => s.name)).toEqual(["typed"]);
});

// ── Codex code review

it("2: an editor opened again after a failed save starts from what it wrote, and a new one stays listed as unsaved", async () => {
  beginEdit("s_aaaaaaaa", null);
  queueSave("s_aaaaaaaa", fields("never stored"), true);
  calls[0]!.reject(new Error("disk full"));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("failed"));
  expect(useUnsaved.getState()["s_aaaaaaaa"]?.name).toBe("never stored");
  // the editor comes back (the list, another tab): same session, its content
  beginEdit("s_aaaaaaaa", null);
  expect(unsavedContent("s_aaaaaaaa")?.name).toBe("never stored");
  retrySave("s_aaaaaaaa");
  calls[1]!.resolve(saved("s_aaaaaaaa", "never stored", 3));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("saved"));
  expect(useUnsaved.getState()).toEqual({});
});

it("3: quitting saves what's waiting at once, and says whether everything is stored", async () => {
  beginEdit("s_aaaaaaaa", 5);
  queueSave("s_aaaaaaaa", fields("typed just now"));
  const done = snippetsSaved(4000);
  expect(calls.map((c) => c.params.name)).toEqual(["typed just now"]);
  calls[0]!.resolve(saved("s_aaaaaaaa", "typed just now", 6));
  expect(await done).toBe(true);
  queueSave("s_aaaaaaaa", fields("again"));
  const failing = snippetsSaved(4000);
  calls[1]!.reject(new Error("gone"));
  expect(await failing).toBe(false);
});

it("4: Load theirs drops what's typed while it loads (theirs is what shows next)", async () => {
  beginEdit("s_aaaaaaaa", 5);
  queueSave("s_aaaaaaaa", fields("mine"), true);
  calls[0]!.reject(Object.assign(new Error("changed"), { code: "STALE" }));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("conflict"));
  const loading = loadTheirs("s_aaaaaaaa");
  queueSave("s_aaaaaaaa", fields("typed meanwhile"));
  calls[1]!.resolve([saved("s_aaaaaaaa", "theirs", 9)]);
  expect(await loading).toMatchObject({ name: "theirs" });
  vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
  expect(calls.map((c) => c.method)).toEqual(["snippets.save", "snippets.list"]);
  // the next change is based on theirs
  queueSave("s_aaaaaaaa", fields("after"), true);
  expect(calls[2]!.params.base).toBe(9);
});

it("5: delete after a save that fails: Undo restores what that save carried", async () => {
  beginEdit("s_aaaaaaaa", 5);
  useSnippets.setState({ list: [saved("s_aaaaaaaa", "old", 5)] });
  queueSave("s_aaaaaaaa", fields("in flight"), true);
  const deleting = deleteSnippet(saved("s_aaaaaaaa", "old", 5));
  calls[0]!.reject(new Error("disk full"));
  await vi.waitFor(() => expect(calls.map((c) => c.method)).toEqual(["snippets.save", "snippets.delete"]));
  calls[1]!.resolve({ ok: true });
  const undo = (await deleting)!;
  const undone = runUndo(undo);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]!.params).toMatchObject({ name: "in flight", base: null });
  calls[2]!.resolve(saved("s_aaaaaaaa", "in flight", 7));
  await undone;
});

it("6: an editor opened again as new (another tab and back) saves on the version it created", async () => {
  beginEdit("s_aaaaaaaa", null);
  queueSave("s_aaaaaaaa", fields("first"), true);
  calls[0]!.resolve(saved("s_aaaaaaaa", "first", 100));
  await vi.waitFor(() => expect(useSaveStatus.getState()["s_aaaaaaaa"]).toBe("saved"));
  beginEdit("s_aaaaaaaa", null);
  queueSave("s_aaaaaaaa", fields("second"), true);
  expect(calls[1]!.params.base).toBe(100);
});

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
const { beginEdit, deleteSnippet, flushSave, keepMine, queueSave, resetSnippetsForTests, retrySave, useSaveStatus, useSnippets, SAVE_DELAY_MS } = await import("./snippets");
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

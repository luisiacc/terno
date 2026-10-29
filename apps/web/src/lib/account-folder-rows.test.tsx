// @vitest-environment jsdom
/**
 * Plan 68 (Codex R14): an account's folder rows are built only while it's open, the first step before the paint
 * (a usual catalog is there at once), a huge one a few milliseconds a task; a closed account never rebuilds.
 */
import type { Folder } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("~/state/app", () => ({ getApp: () => ({}), navigate: () => {} }));
const { useFolderRows } = await import("./account-folders");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const f = (key: string, path: string[]): Folder => ({ accountId: 2, key, path, selectable: true });

function mount() {
  const seen: { names: string[] } = { names: [] };
  function Probe({ folders, open }: { folders: readonly Folder[]; open: boolean }) {
    seen.names = useFolderRows(folders, 2, open).map((r) => r.name);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return { seen, render: (folders: readonly Folder[], open: boolean) => act(async () => root.render(<Probe folders={folders} open={open} />)), unmount: () => act(async () => root.unmount()) };
}

it("open: there at once; closed: the folders change and nothing is rebuilt (what it drew stays); reopened: the new ones", async () => {
  const p = mount();
  await p.render([f("A", ["Alfa"])], false);
  expect(p.seen.names).toEqual([]);
  await p.render([f("A", ["Alfa"])], true);
  expect(p.seen.names).toEqual(["Alfa"]);
  await p.render([f("A", ["Alfa"]), f("B", ["Beta"])], false);
  expect(p.seen.names).toEqual(["Alfa"]);
  await p.render([f("A", ["Alfa"]), f("B", ["Beta"])], true);
  expect(p.seen.names).toEqual(["Alfa", "Beta"]);
  await p.unmount();
});

it("a huge catalog is built over several tasks, never all in one", async () => {
  const p = mount();
  const many = Array.from({ length: 10_000 }, (_, i) => f(`K${i}`, Array.from({ length: 20 }, (_, j) => `S${i}-${j}`)));
  await p.render(many, true);
  expect(p.seen.names).toEqual([]);
  await vi.waitFor(() => expect(p.seen.names).toHaveLength(80_000), { timeout: 10_000 });
  await p.unmount();
});

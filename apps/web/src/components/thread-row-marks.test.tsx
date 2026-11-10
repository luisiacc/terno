// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// the app's stores read the motion preference as they load
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
import type { Category, ThreadSummary } from "@terno/core";
import type { DesignVariants } from "@terno/ui/designs/index";
import { ThreadRowView } from "./thread-row";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const thread: ThreadSummary = {
  id: 1, accountId: 1, subject: "Homepage concepts", snippet: "We looked at the revised C", lastDate: Date.UTC(2026, 10, 9, 9, 6), fromName: "Priya Natarajan", fromEmail: "priya@example.com",
  messageCount: 3, unread: true, starred: true, hasAttachments: true, categoryIds: [7],
};
const categories = [{ id: 7, name: "Clients", color: "green" }, { id: 8, name: "Travel", color: "teal" }, { id: 9, name: "Reading", color: "purple" }] as unknown as Category[];

let host: HTMLDivElement | null = null;
let unmount = async () => {};
afterEach(async () => {
  await unmount();
  host?.remove();
});

async function row(opts: { layout?: DesignVariants["row"]; compact?: boolean; account?: boolean; review?: number } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = () => act(async () => root.unmount());
  await act(async () =>
    root.render(
      <ThreadRowView
        thread={thread} top={0} height={72} compact={opts.compact ?? false} wide={false} icons={false} layout={opts.layout ?? "avatar"} review={opts.review ?? null}
        reminderTop={false} reminderEnd={false} selected={false} checked={false} inSelection={false}
        account={opts.account ? { text: "Studio", email: "me@studio.example" } as never : undefined}
        categories={categories} hasDraft={false} code={null} reminder={undefined} remindersList={false} interactive={false}
      />,
    ),
  );
  return { el: host.querySelector<HTMLElement>("[data-testid=thread-row]")! };
}

it.each(["avatar", "classic", "large-avatar"] as const)("a three-line %s row ends its preview's line with the marks; the sender's line is who, how many and when (plan 173)", async (layout) => {
  const { el } = await row({ layout });
  const snippetLine = el.querySelector("[data-testid=row-snippet]")!.parentElement!;
  const fromLine = el.querySelector("[data-testid=row-from]")!.parentElement!;
  const marks = snippetLine.querySelector("[data-testid=row-marks]")!;
  expect(marks).not.toBeNull();
  expect(marks.querySelector("[data-cat-dot='7']")).not.toBeNull();
  expect(marks.querySelectorAll("svg")).toHaveLength(2); // the clip and the star
  // the marks are the line's last element, on the right edge (no account: they take the free space)
  expect(snippetLine.lastElementChild).toBe(marks);
  expect(marks.className).toContain("ml-auto");
  // the first line: sender, count, then the date at its end, and no mark
  expect(fromLine.querySelector("svg")).toBeNull();
  expect(fromLine.querySelector("[data-cat-dot]")).toBeNull();
  expect(fromLine.lastElementChild!.lastElementChild!.getAttribute("data-testid")).toBe("row-date");
});

it("the account keeps the right edge, the marks just before it (plan 173)", async () => {
  const { el } = await row({ account: true });
  const snippetLine = el.querySelector("[data-testid=row-snippet]")!.parentElement!;
  const tag = snippetLine.querySelector("[data-testid=account-label]")!;
  const marks = snippetLine.querySelector("[data-testid=row-marks]")!;
  expect(marks.nextElementSibling).toBe(tag);
  expect(snippetLine.lastElementChild).toBe(tag);
  expect(marks.className).toContain("ml-auto");
  expect(tag.className).not.toContain("ml-auto");
});

it("a row with no marks draws no slot for them, and its account takes the edge (plan 173)", async () => {
  Object.assign(thread, { starred: false, hasAttachments: false, categoryIds: [] });
  try {
    const { el } = await row({ account: true });
    expect(el.querySelector("[data-testid=row-marks]")).toBeNull();
    expect(el.querySelector("[data-testid=account-label]")!.className).toContain("ml-auto");
  } finally {
    Object.assign(thread, { starred: true, hasAttachments: true, categoryIds: [7] });
  }
});

it("a compact row keeps its marks on its one line", async () => {
  const { el } = await row({ compact: true });
  expect(el.querySelector("[data-testid=row-snippet]")!.closest("div")).toBe(el.querySelector("[data-cat-dot='7']")!.closest("div"));
});

it("in Review the answers have the preview's line, and the marks stay by the date (plan 173)", async () => {
  const { el } = await row({ review: 7 });
  const fromLine = el.querySelector("[data-testid=row-from]")!.parentElement!;
  expect(fromLine.querySelector("[data-cat-dot='7']")).not.toBeNull();
  expect(fromLine.querySelectorAll("svg")).toHaveLength(2); // the clip and the star
  expect(el.querySelector("[data-testid=row-marks]")).toBeNull();
});

it("the preview's line holds two category dots at most, every name in its title; Trash's word stays by the date (plan 173, Codex review)", async () => {
  Object.assign(thread, { categoryIds: [7, 8, 9], inTrash: true });
  try {
    const { el } = await row();
    const marks = el.querySelector("[data-testid=row-marks]")!;
    expect(marks.querySelectorAll("[data-cat-dot]")).toHaveLength(2);
    expect(marks.getAttribute("title")).toBe("Clients, Travel, Reading");
    expect(marks.querySelector("[data-testid=row-place]")).toBeNull();
    const fromLine = el.querySelector("[data-testid=row-from]")!.parentElement!;
    expect(fromLine.querySelector("[data-testid=row-place]")).not.toBeNull();
    // every category is still said
    expect(el.querySelector(".sr-only")!.textContent).toContain("Reading");
  } finally {
    Object.assign(thread, { categoryIds: [7], inTrash: undefined });
  }
});

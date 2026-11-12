// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function row(opts: { layout?: DesignVariants["row"]; compact?: boolean; account?: boolean; review?: number; lines?: 0 | 1 | 2 } = {}) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = () => act(async () => root.unmount());
  await act(async () =>
    root.render(
      <ThreadRowView
        thread={thread} top={0} height={72} compact={opts.compact ?? false} wide={false} icons={false} layout={opts.layout ?? "avatar"} review={opts.review ?? null}
        reminderTop={false} selected={false} checked={false} inSelection={false}
        account={opts.account ? { text: "Studio", email: "me@studio.example" } as never : undefined}
        categories={categories} hasDraft={false} code={null} reminder={undefined} remindersList={false} interactive={false} lines={opts.lines}
      />,
    ),
  );
  return { el: host.querySelector<HTMLElement>("[data-testid=thread-row]")! };
}

it.each(["avatar", "classic", "large-avatar"] as const)("a three-line %s row ends its first line with the marks, before the date; the preview has its line to itself (plan 194)", async (layout) => {
  const { el } = await row({ layout });
  const snippetLine = el.querySelector("[data-testid=row-snippet]")!.parentElement!;
  const fromLine = el.querySelector("[data-testid=row-from]")!.parentElement!;
  const marks = fromLine.querySelector("[data-testid=row-marks]")!;
  expect(marks).not.toBeNull();
  expect(marks.querySelector("[data-cat-dot='7']")).not.toBeNull();
  expect(marks.querySelectorAll("svg")).toHaveLength(2); // the clip and the star
  // they take what the sender leaves, and drop whole from the end when that's short (one glyph tall, wrapping, clipped)
  for (const c of ["flex-1", "basis-0", "flex-wrap", "overflow-hidden", "h-3", "justify-end"]) expect(marks.className).toContain(c);
  // the date still ends the line, after them
  expect(marks.nextElementSibling!.lastElementChild!.getAttribute("data-testid")).toBe("row-date");
  // the preview's line: no mark
  expect(snippetLine.querySelector("svg")).toBeNull();
  expect(snippetLine.querySelector("[data-cat-dot]")).toBeNull();
});

it("the account alone ends the preview's line, on the right edge under the date (plan 194)", async () => {
  const { el } = await row({ account: true });
  const snippetLine = el.querySelector("[data-testid=row-snippet]")!.parentElement!;
  const tag = snippetLine.querySelector("[data-testid=account-label]")!;
  expect(snippetLine.querySelector("[data-testid=row-marks]")).toBeNull();
  expect(snippetLine.lastElementChild).toBe(tag);
  expect(tag.className).toContain("ml-auto");
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

it("the first line holds two category dots at most, every name in its title; Trash's word stays by the date, outside the marks (plan 173, 194)", async () => {
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
    expect(rowName(el)).toContain("Reading");
  } finally {
    Object.assign(thread, { categoryIds: [7], inTrash: undefined });
  }
});

it("the message count is a pill, its words said (plan 194)", async () => {
  const { el } = await row();
  const pill = el.querySelector("[data-slot=badge]")!;
  expect(pill.textContent).toContain("3");
  expect(pill.closest("div")).toBe(el.querySelector("[data-testid=row-from]")!.parentElement);
  expect(rowName(el)).toContain("3 messages");
});

/** The option's name: its own words, in order (aria-hidden parts left out). */
function rowName(el: HTMLElement): string {
  const option = (el.closest("[role=option]") ?? el).cloneNode(true) as HTMLElement;
  option.querySelectorAll("[aria-hidden=true]").forEach((n) => n.remove());
  return option.textContent ?? "";
}

async function pinnedRow(opts: { pinnedTop: boolean; layout?: DesignVariants["row"]; compact?: boolean }) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = () => act(async () => root.unmount());
  await act(async () =>
    root.render(
      <ThreadRowView
        thread={thread} top={0} height={72} compact={opts.compact ?? false} wide={false} icons={false} layout={opts.layout ?? "avatar"} review={null}
        pinnedTop={opts.pinnedTop} reminderTop={false} selected={false} checked={false} inSelection={false}
        account={undefined} categories={categories} hasDraft={false} code={null} reminder={undefined} remindersList={false} interactive={false}
      />,
    ),
  );
  return host.querySelector<HTMLElement>("[data-testid=thread-row]")!;
}

it.each([["avatar", false], ["classic", false], ["large-avatar", false], ["avatar", true]] as const)("a %s row (compact %s) draws no pin; in the Pinned section a screen reader hears it's pinned (plan 179, the owner)", async (layout, compact) => {
  const outside = await pinnedRow({ pinnedTop: false, layout, compact });
  expect(outside.querySelector("svg.lucide-pin, [data-testid=row-pin]")).toBeNull();
  expect(rowName(outside)).not.toContain("pinned");
  await unmount();
  host?.remove();
  const inside = await pinnedRow({ pinnedTop: true, layout, compact });
  expect(inside.querySelector("[data-testid=row-pin]")).toBeNull();
  expect(rowName(inside)).toContain("Priya Natarajan, unread, starred, pinned,");
});

describe("plan 187: the preview's lines", () => {
  it.each(["avatar", "classic", "large-avatar"] as const)("with none, a %s row has no preview; its account ends the subject's line (the marks stay by the date), the subject in the preview's ink", async (layout) => {
    const { el } = await row({ layout, account: true, lines: 0 });
    expect(el.querySelector("[data-testid=row-snippet]")).toBeNull();
    const subject = el.querySelector("[data-testid=row-subject]")!;
    const subjectLine = subject.parentElement!;
    expect(subjectLine.querySelector("[data-testid=row-marks]")).toBeNull();
    expect(el.querySelector("[data-testid=row-from]")!.parentElement!.querySelector("[data-testid=row-marks]")).not.toBeNull();
    expect(subjectLine.lastElementChild!.getAttribute("data-testid")).toBe("account-label");
    // the owner: the subject reads as the preview did, its quiet ink and its weight, unread too (the thread is unread)
    expect(subject.className).toContain("text-muted-foreground");
    expect(subject.className).toContain("[font-weight:var(--type-row-snippet-weight)]");
    expect(subject.className).not.toContain("type-row-subject-strong");
    // two lines: who, then what about (classic's unread dot is a sibling span)
    expect([...subjectLine.parentElement!.children].filter((c) => c.tagName === "DIV")).toHaveLength(2);
  });

  it("with one, the row is as it was: one truncated line, the subject in the row's ink", async () => {
    const { el } = await row({ lines: 1 });
    const snippet = el.querySelector("[data-testid=row-snippet]")!;
    expect(snippet.className).toContain("truncate");
    expect(snippet.className).not.toContain("line-clamp-2");
    expect(el.querySelector("[data-testid=row-subject]")!.className).not.toContain("text-muted-foreground");
    expect(snippet.parentElement!.querySelector("[data-testid=row-marks]")).toBeNull();
  });

  it("with two, the preview wraps and clamps (never nowrap), its line is two lines tall, and the account sits on its first line", async () => {
    const { el } = await row({ lines: 2, account: true });
    const snippet = el.querySelector("[data-testid=row-snippet]")!;
    expect(snippet.className).toContain("line-clamp-2");
    expect(snippet.className).not.toContain("truncate");
    const line = snippet.parentElement!;
    expect(line.className).toContain("min-h-[calc(var(--type-row-snippet-leading)*2)]");
    expect(line.className).toContain("items-start");
    for (const id of ["account-label"]) {
      const c = line.querySelector(`[data-testid=${id}]`)!.className;
      expect(c, id).toContain("self-start");
      expect(c, id).toContain("h-(--type-row-snippet-leading)");
      expect(c, id).not.toContain("self-center");
    }
  });

  it("a compact row ignores it (one line by design)", async () => {
    const { el } = await row({ compact: true, lines: 0 });
    expect(el.querySelector("[data-testid=row-snippet]")).not.toBeNull();
    expect(el.querySelector("[data-testid=row-subject]")!.className).not.toContain("text-muted-foreground");
  });

  it("Review keeps its answers' line even with none", async () => {
    const { el } = await row({ review: 7, lines: 0 });
    expect(el.querySelector("[data-testid=row-marks]")).toBeNull();
    // who, what about, and the answers' line
    expect(el.querySelector("[data-testid=row-subject]")!.parentElement!.nextElementSibling).not.toBeNull();
  });
});

describe("plan 188: what a screen reader hears for a row", () => {
  it.each([["avatar", false, false], ["classic", false, false], ["avatar", true, false], ["avatar", false, true]] as const)("a %s row (compact %s, wide %s): who, its state at once, how many, and the rest at the end", async (layout, compact, wide) => {
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    unmount = () => act(async () => root.unmount());
    await act(async () =>
      root.render(
        <ThreadRowView
          thread={thread} top={0} height={72} compact={compact} wide={wide} icons={false} layout={layout} review={null}
          pinnedTop={false} reminderTop={false} selected={false} checked={false} inSelection={false} position={12}
          account={{ text: "Work", email: "me@work.com" } as never} categories={categories} hasDraft code={null} reminder={undefined} remindersList={false} interactive={false}
        />,
      ),
    );
    const el = host.querySelector<HTMLElement>("[data-testid=thread-row]")!;
    const name = rowName(el);
    // who, then the state at once (never after the preview), then how many: a word with the count, never a bare 3
    expect(name).toMatch(/^Priya Natarajan, unread, starred,3 messages/);
    expect(name.indexOf("unread")).toBeLessThan(name.indexOf("We looked at"));
    // the rest, said once at the end
    expect(name).toMatch(/\. Clients, has attachments, to Work$/);
    // no aria-label: the name is the row's own words, so it holds what's shown (WCAG 2.5.3)
    expect(el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")).toBe(false);
    expect(el.getAttribute("aria-posinset")).toBe("12");
  });
});

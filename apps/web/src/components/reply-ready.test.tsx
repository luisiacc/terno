// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "zustand";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// what's shown, without the backend behind it
const useReplies = create<{ shown: unknown }>(() => ({ shown: null }));
const useReply = vi.fn();
const dismissReply = vi.fn();
const stopReply = vi.fn();
vi.mock("~/lib/replies", () => ({ useReplies, useReply, dismissReply, stopReply }));

const { default: ReplyReady } = await import("./reply-ready");
const { AI_CARD } = await import("./ai-card");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => act(() => useReplies.setState({ shown: null })));

const row = { rowId: "r1", threadId: 7, to: [{ name: "Liam Baker", email: "liam@x.test" }], used: { learning: false, levels: ["person"], examples: 1 } };
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

it("plan 144's addendum: ready, it's the summary's card, the label its header, the draft inside, Use and Dismiss its footer", async () => {
  await act(async () => root.render(<ReplyReady threadId={7} />));
  expect(q("reply-ready")).toBeNull();
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Hey Liam!\nThanks, Luis", row } }));
  const card = q("reply-ready")!;
  expect(card.dataset.phase).toBe("ready");
  expect(card.getAttribute("aria-label")).toBe("Reply ready");
  // the summary's surface: the one class both use, so an AI suggestion looks one way in every style
  expect(card.className.split(" ")).toContain(AI_CARD);
  // the header: the summary's glyph, then the label and the voice
  const header = q("reply-ready-header")!;
  expect(header.parentElement).toBe(card);
  expect(header.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  expect(header.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  // plan 161: who Use writes to, then the voice
  expect(header.textContent).toBe("Reply ready· To Liam Baker· In your voice with Liam");
  // then the draft, then the footer: all inside the card, in that order
  const text = q("reply-ready-text")!;
  const footer = q("reply-ready-footer")!;
  expect([...card.children].filter((c) => c !== q("reply-ready-live"))).toEqual([header, text, footer]);
  expect(text.textContent).toBe("Hey Liam!\nThanks, Luis");
  expect(footer.contains(q("reply-ready-use"))).toBe(true);
  expect(footer.contains(q("reply-ready-dismiss"))).toBe(true);
  expect(footer.textContent).toContain("Press R to reply with this draft");
  expect(q("reply-ready-use")!.textContent).toBe("Use as draft");
  // plan 161: the standard height, not 24 px
  expect(q("reply-ready-use")!.className).toContain("h-7");
  expect(q("reply-ready-dismiss")!.className).toContain("h-7");
  act(() => q("reply-ready-use")!.click());
  expect(useReply).toHaveBeenCalledWith(7);
  act(() => q("reply-ready-dismiss")!.click());
  expect(dismissReply).toHaveBeenCalledWith(7);
  // another conversation's reply isn't this one's
  act(() => useReplies.setState({ shown: { threadId: 8, phase: "ready", text: "x", row } }));
  expect(q("reply-ready")).toBeNull();
});

it("while it writes: the same card, the spinner in the glyph's place, Stop in the footer and nothing to use yet", async () => {
  await act(async () => root.render(<ReplyReady threadId={7} />));
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "writing", text: "Hey", row: null } }));
  const card = q("reply-ready")!;
  expect(card.dataset.phase).toBe("writing");
  expect(card.className.split(" ")).toContain(AI_CARD);
  expect(q("reply-ready-title")!.textContent).toBe("Writing a reply…");
  // the spinner is still a status with its name, as it was before the card (review 3)
  const spinner = q("reply-ready-header")!.firstElementChild!;
  expect(spinner.getAttribute("role")).toBe("status");
  expect(spinner.getAttribute("aria-label")).toBe("Loading");
  expect(spinner.getAttribute("aria-hidden")).toBeNull();
  expect(q("reply-ready-voice")).toBeNull();
  expect(q("reply-ready-footer")!.contains(q("reply-ready-stop"))).toBe(true);
  expect(q("reply-ready-use")).toBeNull();
  // the live region says it once it's ready, never the deltas
  expect(q("reply-ready-live")!.textContent).toBe("");
  act(() => q("reply-ready-stop")!.click());
  expect(stopReply).toHaveBeenCalledWith(7);
});

it("plan 161: the gaps the model left are marked, exactly those, and never while it writes", async () => {
  await act(async () => root.render(<ReplyReady threadId={7} />));
  const gappy = { ...row, checks: { specifics: [], placeholders: ["[What you think.]"] } };
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "writing", text: "Thanks. [What you think.]", row: null } }));
  expect(host.querySelectorAll("[data-testid=reply-ready-gap]")).toHaveLength(0);
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Thanks. [What you think.] See [this] too. [What you think.]", row: gappy } }));
  const marks = [...host.querySelectorAll<HTMLElement>("[data-testid=reply-ready-gap]")];
  expect(marks.map((m) => m.tagName.toLowerCase())).toEqual(["mark", "mark"]);
  expect(marks.map((m) => m.textContent)).toEqual(["[What you think.]", "[What you think.]"]);
  // the text reads the same, marks and all
  expect(q("reply-ready-text")!.textContent).toBe("Thanks. [What you think.] See [this] too. [What you think.]");
});

it("plan 161: several people: the header names them all", async () => {
  const { replyTo } = await import("./reply-ready");
  expect(replyTo({ ...row, to: [{ name: "Liam Baker", email: "l@x.test" }, { name: "", email: "ana@x.test" }] } as never)).toBe("To Liam Baker and ana@x.test");
  expect(replyTo({ ...row, to: [] } as never)).toBeNull();
});

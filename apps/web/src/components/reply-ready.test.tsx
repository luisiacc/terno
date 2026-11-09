// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// what's shown, without the backend behind it
const useReplies = create<{ shown: unknown; all: number | null }>(() => ({ shown: null, all: null }));
const useReply = vi.fn();
const dismissReply = vi.fn();
const stopReply = vi.fn();
const chooseReplyAll = vi.fn((threadId: number, all: boolean) => useReplies.setState({ all: all ? threadId : null }));
vi.mock("~/lib/replies", () => ({ useReplies, useReply, dismissReply, stopReply, chooseReplyAll }));

const { default: ReplyReady } = await import("./reply-ready");
const { AI_CARD } = await import("./ai-card");
const { setApp } = await import("~/state/app");
const { useThreads } = await import("~/state/threads");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => act(() => useReplies.setState({ shown: null, all: null })));

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
  // the header: the summary's glyph, then the label and who it's to
  const header = q("reply-ready-header")!;
  expect(header.parentElement).toBe(card);
  expect(header.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  expect(header.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  // plan 161: who Use writes to; pass 3: the voice is the provenance's, which explains it
  expect(header.textContent).toBe("Reply ready·To Liam Baker");
  // the separators are items of their own: the same gap either side
  expect([...header.children].filter((c) => c.textContent === "·" && c.getAttribute("aria-hidden") === "true")).toHaveLength(1);
  // then the draft, then the footer: all inside the card, in that order
  const text = q("reply-ready-text")!;
  const footer = q("reply-ready-footer")!;
  expect([...card.children].filter((c) => c !== q("reply-ready-live"))).toEqual([header, text, footer]);
  expect(text.textContent).toBe("Hey Liam!\nThanks, Luis");
  expect(footer.contains(q("reply-ready-use"))).toBe(true);
  expect(footer.contains(q("reply-ready-dismiss"))).toBe(true);
  // plan 162 (after ai162-r01): R is the button's own keycap, not a sentence beside it
  expect(footer.textContent).not.toContain("Press R");
  expect(q("reply-ready-use")!.querySelector("[data-slot=shortcut]")).not.toBeNull();
  // pass 3: who wrote it, the one control every AI surface ends its row with
  expect(footer.lastElementChild).toBe(q("reply-ready-provenance"));
  expect(q("reply-ready-provenance")!.tagName.toLowerCase()).toBe("button");
  expect(q("reply-ready-provenance-label")!.textContent).toBe("Written with AI");
  expect(q("reply-ready-use")!.textContent).toMatch(/^Use as draft/);
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

it("plan 161, pass 3: the voice, said with why, and where its words came from, as the composer says them", async () => {
  const { replyVoice } = await import("./reply-ready");
  expect(replyVoice(row as never)).toEqual(["In your voice with Liam: it learned from how you write to Liam.", "What it says comes from this conversation alone: you gave no instruction."]);
  expect(replyVoice({ ...row, used: { learning: false, levels: ["you"], examples: 0 } } as never)[0]).toBe("In your general voice: it hasn’t seen how you write to this person.");
  expect(replyVoice({ ...row, used: { learning: true, levels: [], examples: 0 } } as never)[0]).toBe("Still learning how you write: this used what’s known so far.");
});

it("plan 161: several people: the header names them all", async () => {
  const { replyTo } = await import("./reply-ready");
  expect(replyTo({ ...row, to: [{ name: "Liam Baker", email: "l@x.test" }, { name: "", email: "ana@x.test" }] } as never)).toBe("To Liam Baker and ana@x.test");
  expect(replyTo({ ...row, to: [] } as never)).toBeNull();
});

it("plan 161, pass 2: the header counts the gaps still to fill, in the ink, before Use", async () => {
  await act(async () => root.render(<ReplyReady threadId={7} />));
  const gappy = { ...row, checks: { specifics: [], placeholders: ["[What you think.]", "[When.]", "[Gone.]"] } };
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Thanks. [What you think.] [When.] [What you think.]", row: gappy } }));
  // each gap once, and only those still in the text
  expect(q("reply-ready-gaps")!.textContent).toBe("2 gaps to fill");
  expect(q("reply-ready-gaps")!.className).toContain("text-foreground");
  // plan 162 (after ai162-r03): with a gap left it isn't ready yet: it says drafted, and what's left
  expect(q("reply-ready-header")!.textContent).toBe("Reply drafted·2 gaps to fill·To Liam Baker");
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Thanks. [What you think.]", row: gappy } }));
  expect(q("reply-ready-gaps")!.textContent).toBe("1 gap to fill");
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Thanks.", row: gappy } }));
  expect(q("reply-ready-gaps")).toBeNull();
});

it("plan 161, pass 2: preparing holds its place: skeleton lines until words come, then the text clamped as when it's ready", async () => {
  await act(async () => root.render(<ReplyReady threadId={7} />));
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "writing", text: "", row: null } }));
  expect(q("reply-ready-skeleton")).not.toBeNull();
  expect(q("reply-ready-skeleton")!.children).toHaveLength(3);
  expect(q("reply-ready-text")).toBeNull();
  expect(q("reply-ready-stop")).not.toBeNull();
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "writing", text: "Hey Liam", row: null } }));
  expect(q("reply-ready-skeleton")).toBeNull();
  expect(q("reply-ready-text")!.className).toContain("line-clamp-6");
  // it fades in within --motion, never more
  expect(q("reply-ready")!.className).toContain("duration-base");
});

describe("plan 144, owner's decisions (2): Reply all on a conversation with others in it", () => {
  const me = { name: "Luis Cordero", email: "me@x.test" };
  const liam = { name: "Liam Baker", email: "liam@x.test" };
  const ana = { name: "Ana Ruiz", email: "ana@x.test" };
  const ben = { name: "Ben Wu", email: "ben@x.test" };
  const detail = (cc: { name: string; email: string }[], to = [me]) =>
    ({ thread: { id: 7, accountId: 1, subject: "Plans" }, messages: [{ id: 1, from: liam, to, cc, replyTo: [], isSent: false, date: 1 }] }) as never;
  beforeEach(() => {
    setApp({ accounts: [{ id: 1, email: me.email }] as never });
  });
  afterEach(() => useThreads.setState({ details: new Map() }));

  it("one-to-one: no choice, the header as it was", async () => {
    useThreads.setState({ details: new Map([[7, detail([])]]) });
    await act(async () => root.render(<ReplyReady threadId={7} />));
    act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Hey Liam!", row } }));
    expect(q("reply-ready-mode")).toBeNull();
    expect(q("reply-ready-header")!.textContent).toBe("Reply ready·To Liam Baker");
  });

  it("a group: Reply first, as the reply bar; Reply all names everyone and Use answers with it; never while it writes", async () => {
    useThreads.setState({ details: new Map([[7, detail([ana, ben])]]) });
    await act(async () => root.render(<ReplyReady threadId={7} />));
    act(() => useReplies.setState({ shown: { threadId: 7, phase: "writing", text: "Hey", row: null } }));
    expect(q("reply-ready-mode")).toBeNull();
    act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Hey Liam!", row } }));
    const group = q("reply-ready-mode")!;
    expect(group.getAttribute("aria-label")).toBe("Reply or Reply all");
    // the reply bar's words, in the header, after who it's to
    expect(group.parentElement).toBe(q("reply-ready-header"));
    expect(group.previousElementSibling!.contains(q("reply-ready-title"))).toBe(true);
    expect(q("reply-ready-mode-reply")!.textContent).toBe(" Reply");
    expect(q("reply-ready-mode-all")!.textContent).toBe(" Reply all");
    expect(q("reply-ready-mode-reply")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("reply-ready-to")!.textContent).toBe("To Liam Baker");
    act(() => q("reply-ready-mode-all")!.click());
    expect(chooseReplyAll).toHaveBeenCalledWith(7, true);
    expect(q("reply-ready-mode-all")!.getAttribute("aria-pressed")).toBe("true");
    expect(q("reply-ready-to")!.textContent).toBe("To Liam Baker, cc Ana Ruiz and Ben Wu");
    // the words are the same: no request, nothing rewritten
    expect(q("reply-ready-text")!.textContent).toBe("Hey Liam!");
    act(() => q("reply-ready-mode-reply")!.click());
    expect(q("reply-ready-to")!.textContent).toBe("To Liam Baker");
  });

  it("someone else in To counts, as the reply bar's Reply all does", async () => {
    const { replyAllTo } = await import("./reply-ready");
    expect(replyAllTo(detail([], [me, ana]), [me.email])).toBe("To Liam Baker, cc Ana Ruiz");
    expect(replyAllTo(detail([]), [me.email])).toBeNull();
    // Spanish too
    setLocale("es", es);
    expect(replyAllTo(detail([ana, ben]), [me.email])).toBe("Para Liam Baker, cc Ana Ruiz y Ben Wu");
    setLocale("en", en);
  });
});

it("plan 162 (Codex review): Dismiss gives the keys to the reply bar once the dismissal is done, however long the backend takes", async () => {
  const bar = document.body.appendChild(Object.assign(document.createElement("button"), { textContent: "Reply" }));
  bar.setAttribute("data-testid", "quick-reply");
  let finish!: () => void;
  dismissReply.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => root.render(<ReplyReady threadId={7} />));
  act(() => useReplies.setState({ shown: { threadId: 7, phase: "ready", text: "Hey", row } }));
  q("reply-ready-dismiss")!.focus();
  act(() => q("reply-ready-dismiss")!.click());
  // two frames pass while the backend hasn't answered: nothing has moved the keys yet
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  expect(document.activeElement).not.toBe(bar);
  // it answers, the card goes (focus falls to the page), then the bar takes the keys
  await act(async () => { finish(); useReplies.setState({ shown: null }); });
  (document.activeElement as HTMLElement | null)?.blur();
  await new Promise((r) => requestAnimationFrame(r));
  expect(document.activeElement).toBe(bar);
  bar.remove();
});

import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, resolveKey, shortcutsFor, type KeyContext, type KeyInput } from "./resolve";

const ctx: KeyContext = { editable: false, composing: false, dialogOpen: false };
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, meta: false, ctrl: false, alt: false, shift: false, ...mods });

describe("resolveKey", () => {
  it("resolves single keys", () => {
    expect(resolveKey(key("j"), ctx, null).command).toBe("list.next");
    expect(resolveKey(key("E", { shift: true }), ctx, null).command).toBe(null); // shift+e is not archive
  });

  it("treats shifted symbols by their produced character", () => {
    expect(resolveKey(key("#", { shift: true }), ctx, null).command).toBe("thread.trash");
    expect(resolveKey(key("!", { shift: true }), ctx, null).command).toBe("thread.spam");
  });

  it("handles two-key sequences and recovers from a broken sequence", () => {
    const first = resolveKey(key("g"), ctx, null);
    expect(first).toEqual({ command: null, pending: "g" });
    expect(resolveKey(key("i"), ctx, first.pending).command).toBe("go.inbox");
    // "g" then "e": not a sequence, so "e" alone still archives
    expect(resolveKey(key("e"), ctx, "g")).toEqual({ command: "thread.archive", pending: null });
  });

  it("ignores single-letter shortcuts while typing but keeps mod chords", () => {
    const typing = { ...ctx, editable: true };
    expect(resolveKey(key("e"), typing, null).command).toBe(null);
    expect(resolveKey(key("k", { meta: true }), typing, null).command).toBe("palette.open");
    expect(resolveKey(key("Enter", { meta: true }), { ...typing, composing: true }, null).command).toBe("compose.send");
  });

  it("⌘, (Ctrl+, off Mac) opens settings from anywhere, also while typing or composing", () => {
    expect(resolveKey(key(",", { meta: true }), ctx, null).command).toBe("settings.open");
    expect(resolveKey(key(",", { meta: true }), { ...ctx, editable: true }, null).command).toBe("settings.open");
    expect(resolveKey(key(",", { ctrl: true }), ctx, null, undefined, false).command).toBe("settings.open");
    expect(resolveKey(key(",", { meta: true }), { ...ctx, editable: true, composing: true }, null).command).toBe("settings.open");
    expect(resolveKey(key(","), ctx, null).command).toBe(null);
  });

  it("⌘P / ⇧⌘P resolve everywhere, so the browser never prints the app window", () => {
    for (const c of [ctx, { ...ctx, editable: true }, { ...ctx, dialogOpen: true }, { ...ctx, editable: true, composing: true }]) {
      expect(resolveKey(key("p", { meta: true }), c, null).command).toBe("thread.print");
      expect(resolveKey(key("P", { meta: true, shift: true }), c, null).command).toBe("thread.exportPdf");
    }
    expect(resolveKey(key("p", { ctrl: true }), ctx, null, undefined, false).command).toBe("thread.print");
    expect(resolveKey(key("p"), ctx, null).command).toBe(null);
  });

  it("⌘L (Mail's message filter) toggles the unread filter from anywhere, never l's category picker or ⇧⌘L's star", () => {
    for (const c of [ctx, { ...ctx, editable: true }, { ...ctx, dialogOpen: true }, { ...ctx, editable: true, composing: true }]) {
      expect(resolveKey(key("l", { meta: true }), c, null).command).toBe("list.toggleUnread");
    }
    expect(resolveKey(key("l", { ctrl: true }), ctx, null, undefined, false).command).toBe("list.toggleUnread");
    expect(resolveKey(key("l"), ctx, null).command).toBe("thread.category");
    expect(resolveKey(key("L", { meta: true, shift: true }), ctx, null).command).toBe("thread.star");
    // ⌃L on a Mac is not ⌘L
    expect(resolveKey(key("l", { ctrl: true }), ctx, null).command).toBe(null);
  });

  it("uses ctrl as mod on non-mac platforms", () => {
    expect(resolveKey(key("k", { ctrl: true }), ctx, null, undefined, false).command).toBe("palette.open");
    expect(resolveKey(key("k", { ctrl: true }), ctx, null, undefined, true).command).toBe(null);
  });
});

describe("snackbar context", () => {
  const ctx = { editable: false, composing: false, dialogOpen: false };
  const key = (k: string) => ({ key: k, meta: false, ctrl: false, alt: false, shift: false });
  it("numbers, z and escape belong to the snackbar while it is up, and only then", () => {
    expect(resolveKey(key("1"), { ...ctx, snackbar: true }, null).command).toBe("snackbar.action1");
    expect(resolveKey(key("5"), { ...ctx, snackbar: true }, null).command).toBe("snackbar.action5");
    expect(resolveKey(key("z"), { ...ctx, snackbar: true }, null).command).toBe("snackbar.undo");
    expect(resolveKey(key("Escape"), { ...ctx, snackbar: true }, null).command).toBe("snackbar.close");
    expect(resolveKey(key("1"), ctx, null).command).toBeNull();
    expect(resolveKey(key("Escape"), ctx, null).command).toBe("reader.close");
    // other keys keep working with the snackbar up
    expect(resolveKey(key("j"), { ...ctx, snackbar: true }, null).command).toBe("list.next");
  });
  it("typing in a field is never hijacked", () => {
    expect(resolveKey(key("1"), { ...ctx, editable: true, snackbar: true }, null).command).toBeNull();
  });
});

describe("selection and triage bindings (plan 06)", () => {
  const ctx: KeyContext = { editable: false, composing: false, dialogOpen: false };
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, meta: false, ctrl: false, alt: false, shift: false, ...mods });
  const run = (keys: KeyInput[], c: KeyContext = ctx, isMac = true) => {
    let pending: string | null = null;
    let command = null;
    for (const k of keys) ({ command, pending } = resolveKey(k, c, pending, undefined, isMac));
    return command;
  };

  it("⌘A selects all on Mac, Ctrl+A elsewhere; the other platform's chord doesn't", () => {
    expect(run([key("a", { meta: true })])).toBe("list.selectAll");
    expect(run([key("a", { ctrl: true })], ctx, false)).toBe("list.selectAll");
    expect(run([key("a", { ctrl: true })])).toBeNull(); // ⌃A on a Mac is "start of line", not select all
    expect(run([key("a")])).toBe("compose.replyAll");
  });

  it("⌘A, ⌘Z, ⌫ and every single key keep their text meaning while typing", () => {
    const typing = { ...ctx, editable: true };
    for (const k of [key("a", { meta: true }), key("z", { meta: true }), key("Backspace"), key("Delete"), key("Backspace", { meta: true }), key("I", { shift: true }), key("U", { shift: true }), key("u", { meta: true, shift: true }), key("J", { shift: true }), key("ArrowDown", { shift: true }), key("v"), key("z"), key("*"), key("F10", { shift: true })]) {
      expect(resolveKey(k, typing, null).command, JSON.stringify(k)).toBeNull();
    }
    // a "*" typed into a field doesn't leave a pending sequence behind either
    expect(resolveKey(key("*"), typing, null).pending).toBeNull();
  });

  it("none of them fire while a dialog (or the context menu) is open", () => {
    const dialog = { ...ctx, dialogOpen: true };
    for (const k of [key("a", { meta: true }), key("Delete"), key("I", { shift: true }), key("z", { meta: true }), key("ContextMenu")]) expect(resolveKey(k, dialog, null).command).toBeNull();
  });

  it("Gmail's * sequences select among the loaded rows", () => {
    expect(resolveKey(key("*", { shift: true }), ctx, null)).toEqual({ command: null, pending: "*" });
    expect(run([key("*", { shift: true }), key("a")])).toBe("list.selectAll");
    expect(run([key("*", { shift: true }), key("n")])).toBe("list.selectNone");
    expect(run([key("*", { shift: true }), key("r")])).toBe("list.selectRead");
    expect(run([key("*", { shift: true }), key("u")])).toBe("list.selectUnread");
    expect(run([key("*", { shift: true }), key("s")])).toBe("list.selectStarred");
    // a broken sequence falls back to the key alone
    expect(run([key("*", { shift: true }), key("e")])).toBe("thread.archive");
  });

  it("⇧J/⇧K and ⇧↓/⇧↑ extend; plain j/k and arrows still move", () => {
    expect(run([key("J", { shift: true })])).toBe("list.extendNext");
    expect(run([key("ArrowDown", { shift: true })])).toBe("list.extendNext");
    expect(run([key("K", { shift: true })])).toBe("list.extendPrev");
    expect(run([key("ArrowUp", { shift: true })])).toBe("list.extendPrev");
    expect(run([key("ArrowDown")])).toBe("list.next");
    expect(run([key("k")])).toBe("list.prev");
  });

  it("trash: #, ⌫, Delete (⌦) and ⌘⌫", () => {
    for (const k of [key("#", { shift: true }), key("Backspace"), key("Delete"), key("Backspace", { meta: true })]) expect(run([k])).toBe("thread.trash");
    expect(run([key("Backspace", { ctrl: true })], ctx, false)).toBe("thread.trash");
  });

  it("read state: ⇧I read, ⌘⇧U toggles; u marks nothing", () => {
    expect(run([key("I", { shift: true })])).toBe("thread.markRead");
    expect(run([key("u", { meta: true, shift: true })])).toBe("thread.toggleRead");
    expect(run([key("u")])).toBeNull();
    expect(run([key("i")])).toBeNull();
  });

  it("the quick filters: ⇧U Unread, ⇧A All; a stays Reply All", () => {
    expect(run([key("U", { shift: true })])).toBe("list.filterUnread");
    expect(run([key("A", { shift: true })])).toBe("list.filterAll");
    expect(run([key("a")])).toBe("compose.replyAll");
    expect(run([key("A", { shift: true })], { ...ctx, editable: true })).toBeNull();
  });

  it("Apple Mail's chords: ⌃⌘A archive, ⌘⇧J spam, ⌘⇧L star; e, !, s stay", () => {
    expect(run([key("a", { meta: true, ctrl: true })])).toBe("thread.archive");
    expect(run([key("j", { meta: true, shift: true })])).toBe("thread.spam");
    expect(run([key("l", { meta: true, shift: true })])).toBe("thread.star");
    expect(run([key("e")])).toBe("thread.archive");
    expect(run([key("!", { shift: true })])).toBe("thread.spam");
    expect(run([key("s")])).toBe("thread.star");
  });

  it("v moves, z and ⌘Z undo, but the snackbar's z wins while it is up", () => {
    expect(run([key("v")])).toBe("thread.move");
    expect(run([key("z")])).toBe("action.undo");
    expect(run([key("z", { meta: true })])).toBe("action.undo");
    expect(run([key("z")], { ...ctx, snackbar: true })).toBe("snackbar.undo");
  });

  it("⇧F10 and the ContextMenu key open the context menu", () => {
    expect(run([key("F10", { shift: true })])).toBe("list.menu");
    expect(run([key("ContextMenu")])).toBe("list.menu");
    expect(run([key("F10")])).toBeNull();
  });

  it("no new binding shadows an existing one", () => {
    const seen = new Map<string, string>();
    for (const b of DEFAULT_BINDINGS) {
      const k = `${b.context ?? ""}|${b.keys}`;
      expect(seen.get(k), `${b.keys} is bound twice`).toBeUndefined();
      seen.set(k, b.command);
    }
    // every multi-key sequence's first key is not itself a command (it would never wait)
    for (const b of DEFAULT_BINDINGS.filter((b) => b.keys.includes(" "))) expect(DEFAULT_BINDINGS.some((x) => x.keys === b.keys.split(" ")[0])).toBe(false);
  });

  it("the help dialog lists every binding of a command; ⌃⌘ chords only on Mac", () => {
    expect(shortcutsFor("thread.trash")).toEqual(["backspace", "#", "delete", "mod+backspace"]);
    expect(shortcutsFor("thread.archive")).toEqual(["e", "mod+ctrl+a"]);
    expect(shortcutsFor("thread.archive", undefined, false)).toEqual(["e"]);
  });
});

describe("back and forward (plan 24)", () => {
  it("⌘[ and ⌘] (Ctrl off Mac) go back and forward, never while typing or under a dialog", () => {
    expect(resolveKey(key("[", { meta: true }), ctx, null).command).toBe("nav.back");
    expect(resolveKey(key("]", { meta: true }), ctx, null).command).toBe("nav.forward");
    expect(resolveKey(key("[", { ctrl: true }), ctx, null, undefined, false).command).toBe("nav.back");
    expect(resolveKey(key("[", { meta: true }), { ...ctx, editable: true }, null).command).toBeNull();
    expect(resolveKey(key("[", { meta: true }), { ...ctx, dialogOpen: true }, null).command).toBeNull();
    // a bare bracket is nothing
    expect(resolveKey(key("["), ctx, null).command).toBeNull();
  });
  it("Esc is the snackbar's first, then the reader's (Back in List); never while typing", () => {
    expect(resolveKey(key("Escape"), { ...ctx, snackbar: true }, null).command).toBe("snackbar.close");
    expect(resolveKey(key("Escape"), ctx, null).command).toBe("reader.close");
    expect(resolveKey(key("Escape"), { ...ctx, editable: true }, null).command).toBeNull();
  });
});

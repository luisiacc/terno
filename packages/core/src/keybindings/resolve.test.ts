import { describe, expect, it } from "vitest";
import { resolveKey, type KeyContext, type KeyInput } from "./resolve";

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

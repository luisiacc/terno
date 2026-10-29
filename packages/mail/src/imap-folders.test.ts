/**
 * Plan 68: which mailboxes of a LIST are the account's own folders, and how they're named.
 */
import { FOLDER_NAME_MAX, FOLDERS_PER_ACCOUNT_MAX } from "@terno/core";
import { describe, expect, it } from "vitest";
import { customFolders, heldUidnext, IMAP_JOURNAL_LIMITS, resetRoom } from "./imap";

type Listed = Parameters<typeof customFolders>[0][number];
const box = (path: string, o: { flags?: string[]; specialUse?: string; delimiter?: string } = {}) =>
  ({ path, name: path.split(o.delimiter ?? "/").at(-1)!, delimiter: o.delimiter ?? "/", flags: new Set(o.flags ?? []), specialUse: o.specialUse, parentPath: "", parent: [], listed: true, subscribed: true }) as unknown as Listed;

describe("customFolders", () => {
  it("leaves out roles (by special-use or by name), INBOX, server specials and what doesn't exist", () => {
    const list = [
      box("INBOX"),
      box("Sent", { specialUse: "\\Sent" }),
      box("Papelera"),
      box("[Gmail]", { flags: ["\\Noselect"] }),
      box("[Gmail]/Starred", { specialUse: "\\Flagged" }),
      box("[Gmail]/Important", { specialUse: "\\Important" }),
      box("Ghost", { flags: ["\\NonExistent"] }),
      box("Work"),
    ];
    expect(customFolders(list, { inbox: "INBOX", sent: "Sent", trash: "Papelera" })).toEqual([{ key: "Work", path: ["Work"], selectable: true }]);
  });

  it("a \\Noselect parent groups what's under it (only when something is); a leading INBOX isn't shown", () => {
    const list = [box("Lists", { flags: ["\\Noselect"] }), box("Lists/News"), box("Empty", { flags: ["\\Noselect"] }), box("INBOX.Clientes", { delimiter: "." })];
    expect(customFolders(list, { inbox: "INBOX" })).toEqual([
      { key: "Lists", path: ["Lists"], selectable: false },
      { key: "Lists/News", path: ["Lists", "News"], selectable: true },
      { key: "INBOX.Clientes", path: ["Clientes"], selectable: true },
    ]);
  });

  it("Codex R1: 10,000 groups over 10,000 folders are sorted out in linear time, in the server's order (the sidebar draws by name)", () => {
    const list = Array.from({ length: 10_000 }, (_, i) => [box(`G${i}`, { flags: ["\\Noselect"] }), box(`G${i}/F`)]).flat();
    const started = performance.now();
    const out = customFolders(list, {});
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toHaveLength(FOLDERS_PER_ACCOUNT_MAX);
    expect(out.slice(0, 2)).toEqual([{ key: "G0", path: ["G0"], selectable: false }, { key: "G0/F", path: ["G0", "F"], selectable: true }]);
    // Codex R17: never sorted here (the sidebar puts "A/Z" under "A", before "AA": account-folders.test.ts)
    expect(customFolders([box("AA"), box("A/Z"), box("A")], {}).map((f) => f.key)).toEqual(["AA", "A/Z", "A"]);
  });

  it("Codex R2: a folder named like a role in another case is its own (only INBOX is case-insensitive)", () => {
    expect(customFolders([box("Sent", { specialUse: "\\Sent" }), box("sent"), box("inbox")], { inbox: "INBOX", sent: "Sent" }).map((f) => f.key)).toEqual(["sent"]);
  });

  it("is bounded: path length and count; names whole (Codex R9: shortened ones could merge two hierarchies)", () => {
    const long = "x".repeat(FOLDER_NAME_MAX + 50);
    expect(customFolders([box(long)], {})[0]!.path[0]).toHaveLength(FOLDER_NAME_MAX + 50);
    const a = `${"p".repeat(FOLDER_NAME_MAX)}a`;
    const b = `${"p".repeat(FOLDER_NAME_MAX)}b`;
    expect(customFolders([box(a), box(`${a}/x`), box(b), box(`${b}/y`)], {}).map((f) => f.path)).toEqual([[a], [a, "x"], [b], [b, "y"]]);
    expect(new Set(customFolders([box(a), box(b)], {}).map((f) => f.key)).size).toBe(2);
    expect(customFolders([box("y".repeat(1001))], {})).toEqual([]);
    const many = Array.from({ length: FOLDERS_PER_ACCOUNT_MAX + 5 }, (_, i) => box(`F${i}`));
    expect(customFolders(many, {})).toHaveLength(FOLDERS_PER_ACCOUNT_MAX);
  });
});

describe("heldUidnext", () => {
  it("Codex R24: a folder's UIDNEXT below its first held-back message, with more of them than an argument list takes", () => {
    const held = Array.from({ length: 500_000 }, (_, i) => ({ uid: 600_000 - i }));
    expect(heldUidnext(700_000, held)).toBe(100_001);
    expect(heldUidnext(50, held)).toBe(50);
    expect(heldUidnext(9, [])).toBe(9);
  });
});

describe("resetRoom", () => {
  it("Codex R52: every folder's reset ids together stay within the cursor's limit", () => {
    const pending: Record<string, number[]> = {};
    const ids = Array.from({ length: 200_000 }, (_, i) => i + 1);
    for (let f = 0; f < 20; f++) pending[`F${f}`] = ids.slice(0, resetRoom(pending, `F${f}`));
    expect(Object.values(pending).reduce((n, list) => n + list.length, 0)).toBeLessThanOrEqual(IMAP_JOURNAL_LIMITS.resetPending);
    // a folder's own ids don't count against it again
    expect(resetRoom({ A: [1, 2, 3] }, "A")).toBe(IMAP_JOURNAL_LIMITS.resetPending);
  });
});

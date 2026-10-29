/**
 * Plan 65: which mailboxes of a LIST are the account's own folders, and how they're named.
 */
import { FOLDER_NAME_MAX, FOLDERS_PER_ACCOUNT_MAX } from "@terno/core";
import { describe, expect, it } from "vitest";
import { customFolders } from "./imap";

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
      { key: "INBOX.Clientes", path: ["Clientes"], selectable: true },
      { key: "Lists", path: ["Lists"], selectable: false },
      { key: "Lists/News", path: ["Lists", "News"], selectable: true },
    ]);
  });

  it("Codex R1: 10,000 groups over 10,000 folders are sorted out in linear time, a parent always before its children", () => {
    const list = Array.from({ length: 10_000 }, (_, i) => [box(`G${i}`, { flags: ["\\Noselect"] }), box(`G${i}/F`)]).flat();
    const started = performance.now();
    const out = customFolders(list, {});
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).toHaveLength(FOLDERS_PER_ACCOUNT_MAX);
    expect(out.slice(0, 2)).toEqual([{ key: "G0", path: ["G0"], selectable: false }, { key: "G0/F", path: ["G0", "F"], selectable: true }]);
    // "A", "AA", "A/Z": the child stays with its parent
    expect(customFolders([box("AA"), box("A/Z"), box("A")], {}).map((f) => f.key)).toEqual(["A", "A/Z", "AA"]);
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
    expect(customFolders([box("y".repeat(1001))], {})).toEqual([]);
    const many = Array.from({ length: FOLDERS_PER_ACCOUNT_MAX + 5 }, (_, i) => box(`F${i}`));
    expect(customFolders(many, {})).toHaveLength(FOLDERS_PER_ACCOUNT_MAX);
  });
});

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

  it("is bounded: names, path length and count", () => {
    const long = "x".repeat(FOLDER_NAME_MAX + 50);
    expect(customFolders([box(long)], {})[0]!.path[0]).toHaveLength(FOLDER_NAME_MAX);
    expect(customFolders([box("y".repeat(1001))], {})).toEqual([]);
    const many = Array.from({ length: FOLDERS_PER_ACCOUNT_MAX + 5 }, (_, i) => box(`F${i}`));
    expect(customFolders(many, {})).toHaveLength(FOLDERS_PER_ACCOUNT_MAX);
  });
});

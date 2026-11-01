/**
 * Plan 107: a folder change is checked against the server's own catalog before anything is sent: IMAP's LIST (its
 * delimiter, an INBOX prefix, siblings by the server's names), Gmail's raw /labels (sublabels by name, collisions with
 * any label), and the demo's stored list. Gmail's changes go label by label; one refused midway is said, with the
 * labels read again.
 */
import { FOLDER_NAME_MAX } from "@terno/core";
import { describe, expect, it } from "vitest";
import { demoFolderChange, planImapCreate, planImapDelete, planImapRename, planLabelCreate, planLabelDelete, planLabelRename, type LabelName, type ListedPath } from "./folder-changes";
import { createGmailApiProvider } from "./gmail-api";
import type { ProviderContext, SyncSink } from "./types";

const box = (path: string, o: { delimiter?: string | null; flags?: string[] } = {}): ListedPath => ({ path, delimiter: o.delimiter === undefined ? "/" : o.delimiter, flags: new Set(o.flags ?? []) });
const keyOf = (e: unknown) => (e as { i18n?: { key: string } }).i18n?.key;
const throwsKey = (fn: () => unknown) => {
  try { fn(); } catch (e) { return keyOf(e); }
  return null;
};

describe("IMAP: a change checked on a fresh LIST", () => {
  const list = [box("INBOX"), box("Sent"), box("Work"), box("Work/Clients"), box("Work/Clients/Acme"), box("Lists", { flags: ["\\Noselect"] }), box("Lists/News"), box("Ghost", { flags: ["\\NonExistent"] })];
  const own = new Set(["Work", "Work/Clients", "Work/Clients/Acme", "Lists", "Lists/News"]);
  const roles = { inbox: "INBOX", sent: "Sent" };

  it("creates at the top or under a folder with the server's delimiter; a sibling taken in any case, the delimiter, or a standard parent are refused", () => {
    expect(planImapCreate(list, own, null, "Travel", "")).toBe("Travel");
    expect(planImapCreate(list, own, "Work", "Invoices", "")).toBe("Work/Invoices");
    expect(planImapCreate(list, own, "Lists", "Digest", "")).toBe("Lists/Digest");
    expect(throwsKey(() => planImapCreate(list, own, "Work", "clients", ""))).toBe("errors.folder.nameTaken");
    expect(throwsKey(() => planImapCreate(list, own, null, "work", ""))).toBe("errors.folder.nameTaken");
    // INBOX is any case at the top
    expect(throwsKey(() => planImapCreate(list, own, null, "Inbox", ""))).toBe("errors.folder.nameTaken");
    expect(throwsKey(() => planImapCreate(list, own, null, "a/b", ""))).toBe("errors.folder.nameSeparator");
    expect(throwsKey(() => planImapCreate(list, own, "Sent", "x", ""))).toBe("errors.folder.standard");
    expect(throwsKey(() => planImapCreate(list, own, "Nope", "x", ""))).toBe("errors.folder.notFound");
    // a name that doesn't exist on the server any more is no sibling
    expect(planImapCreate(list, own, null, "Ghost", "")).toBe("Ghost");
    expect(throwsKey(() => planImapCreate(list, own, "Work", "x".repeat(FOLDER_NAME_MAX + 1), ""))).toBe("errors.folder.nameTooLong");
  });

  it("an INBOX-prefixed server: the top is under INBOX (its delimiter), and siblings are compared there", () => {
    const dotted = [box("INBOX", { delimiter: "." }), box("INBOX.Clientes", { delimiter: "." }), box("INBOX.Sent", { delimiter: "." })];
    const mine = new Set(["INBOX.Clientes"]);
    expect(planImapCreate(dotted, mine, null, "Viajes", "INBOX.")).toBe("INBOX.Viajes");
    expect(throwsKey(() => planImapCreate(dotted, mine, null, "clientes", "INBOX."))).toBe("errors.folder.nameTaken");
    // "/" is just a character there; "." is the separator
    expect(planImapCreate(dotted, mine, "INBOX.Clientes", "a/b", "INBOX.")).toBe("INBOX.Clientes.a/b");
    expect(throwsKey(() => planImapCreate(dotted, mine, "INBOX.Clientes", "a.b", "INBOX."))).toBe("errors.folder.nameSeparator");
    expect(planImapRename(dotted, mine, { inbox: "INBOX", sent: "INBOX.Sent" }, "INBOX.Clientes", "Clients", "INBOX.")).toEqual({ path: "INBOX.Clients", moves: [{ from: "INBOX.Clientes", to: "INBOX.Clients" }] });
  });

  it("a server with no delimiter keeps no folder inside another", () => {
    const flat = [box("INBOX", { delimiter: null }), box("Work", { delimiter: null })];
    expect(throwsKey(() => planImapCreate(flat, new Set(["Work"]), "Work", "x", ""))).toBe("errors.folder.noNesting");
    expect(planImapCreate(flat, new Set(["Work"]), null, "a/b", "")).toBe("a/b");
  });

  it("renames a folder with its subtree (computed from the LIST), never onto a sibling's name; a case change is its own", () => {
    expect(planImapRename(list, own, roles, "Work/Clients", "Customers", "")).toEqual({
      path: "Work/Customers",
      moves: [{ from: "Work/Clients", to: "Work/Customers" }, { from: "Work/Clients/Acme", to: "Work/Customers/Acme" }],
    });
    expect(planImapRename(list, own, roles, "Work", "work", "").path).toBe("work");
    expect(throwsKey(() => planImapRename(list, own, roles, "Lists", "work", ""))).toBe("errors.folder.nameTaken");
    expect(throwsKey(() => planImapRename(list, own, roles, "INBOX", "x", ""))).toBe("errors.folder.standard");
    expect(throwsKey(() => planImapRename(list, own, roles, "Sent", "x", ""))).toBe("errors.folder.standard");
    // a role mailbox nested under an own folder goes nowhere with it
    const nested = [...list, box("Work/Sent")];
    expect(throwsKey(() => planImapRename(nested, own, { ...roles, sent: "Work/Sent" }, "Work", "Job", ""))).toBe("errors.folder.standard");
  });

  it("never makes a folder role discovery would take for a standard one by its name (Codex code review round 9 #1)", () => {
    // no archive or trash here: "Archive" or "trash" would be read as the account's, and the folder would vanish
    expect(throwsKey(() => planImapRename(list, own, roles, "Work", "Archive", ""))).toBe("errors.folder.reservedName");
    expect(throwsKey(() => planImapCreate(list, own, null, "trash", ""))).toBe("errors.folder.reservedName");
    expect(throwsKey(() => planImapCreate(list, own, null, "Papelera", ""))).toBe("errors.folder.reservedName");
    // under INBOX, where such servers keep the top
    const dotted = [box("INBOX", { delimiter: "." }), box("INBOX.Clientes", { delimiter: "." })];
    expect(throwsKey(() => planImapRename(dotted, new Set(["INBOX.Clientes"]), { inbox: "INBOX" }, "INBOX.Clientes", "Archivo", "INBOX."))).toBe("errors.folder.reservedName");
    // a role held by name only could move to the new one (the LIST's first match wins)
    const named = [...list, box("Archives")];
    expect(throwsKey(() => planImapCreate(named, own, null, "Archive", ""))).toBe("errors.folder.reservedName");
    // a role a mailbox holds by its flag stays there: the name is just a name
    const flagged = [...list, box("Old Mail", { flags: ["\\Archive"] })];
    expect(planImapCreate(flagged, own, null, "Archive", "")).toBe("Archive");
    expect(planImapRename(flagged, own, roles, "Work", "Archive", "").path).toBe("Archive");
    // nested, a name is only a name
    expect(planImapCreate(list, own, "Work", "Archive", "")).toBe("Work/Archive");
    expect(planImapRename(list, own, roles, "Work/Clients", "Trash", "").path).toBe("Work/Trash");
  });

  it("deletes a subtree deepest first; never a standard folder or one holding one", () => {
    expect(planImapDelete(list, own, roles, "Work")).toEqual(["Work/Clients/Acme", "Work/Clients", "Work"]);
    expect(planImapDelete(list, own, roles, "Lists")).toEqual(["Lists/News", "Lists"]);
    expect(throwsKey(() => planImapDelete(list, own, roles, "Sent"))).toBe("errors.folder.standard");
    expect(throwsKey(() => planImapDelete([...list, box("Work/Sent")], own, { ...roles, sent: "Work/Sent" }, "Work"))).toBe("errors.folder.standard");
    expect(throwsKey(() => planImapDelete(list, own, roles, "Gone"))).toBe("errors.folder.notFound");
  });

  it("never takes a server special the sidebar doesn't show, nested under an own folder (Codex code review round 2 #1)", () => {
    // what customFolders leaves out: \Important, \Flagged and the special-use roles
    for (const flag of ["\\Important", "\\Flagged", "\\Junk"]) {
      const nested = [...list, box("Work/Special", { flags: [flag] })];
      expect(throwsKey(() => planImapDelete(nested, own, roles, "Work"))).toBe("errors.folder.standard");
      expect(throwsKey(() => planImapRename(nested, own, roles, "Work", "Job", ""))).toBe("errors.folder.standard");
    }
    // an empty group under it holds no mail: it goes with it
    expect(planImapDelete([...list, box("Work/Empty", { flags: ["\\Noselect"] })], own, roles, "Work")).toEqual(["Work/Clients/Acme", "Work/Clients", "Work/Empty", "Work"]);
  });
});

describe("Gmail: a change checked on the raw label catalog", () => {
  const labels: LabelName[] = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Work", type: "user" },
    { id: "Label_2", name: "Work/Clients", type: "user" },
    { id: "Label_3", name: "Work/Clients/Acme", type: "user" },
    // hidden from the list, still a label: a sublabel and a name taken
    { id: "Label_4", name: "Work/Archive", type: "user" },
    { id: "Label_5", name: "Workshop", type: "user" },
    { id: "Label_6", name: "Travel", type: "user" },
  ];

  it("names a new label by its parent's exact name; any label's name, hidden or system, any case, is taken", () => {
    expect(planLabelCreate(labels, null, "Receipts")).toBe("Receipts");
    expect(planLabelCreate(labels, "Label_2", "Globex")).toBe("Work/Clients/Globex");
    expect(throwsKey(() => planLabelCreate(labels, "Label_1", "archive"))).toBe("errors.folder.nameTaken");
    expect(throwsKey(() => planLabelCreate(labels, null, "inbox"))).toBe("errors.folder.nameTaken");
    expect(throwsKey(() => planLabelCreate(labels, null, "a/b"))).toBe("errors.folder.nameSeparator");
    expect(throwsKey(() => planLabelCreate(labels, "INBOX", "x"))).toBe("errors.folder.standard");
    expect(throwsKey(() => planLabelCreate(labels, "Label_9", "x"))).toBe("errors.folder.notFound");
    // Gmail's limit is the full name's
    expect(throwsKey(() => planLabelCreate(labels, "Label_2", "x".repeat(FOLDER_NAME_MAX - 5)))).toBe("errors.folder.nameTooLong");
  });

  it("renames a label and every sublabel by name (not a name that only starts the same), every new name checked first", () => {
    expect(planLabelRename(labels, "Label_1", "Job")).toEqual([
      { id: "Label_1", from: "Work", to: "Job" },
      { id: "Label_2", from: "Work/Clients", to: "Job/Clients" },
      { id: "Label_3", from: "Work/Clients/Acme", to: "Job/Clients/Acme" },
      { id: "Label_4", from: "Work/Archive", to: "Job/Archive" },
    ]);
    expect(planLabelRename(labels, "Label_2", "Customers").map((m) => m.to)).toEqual(["Work/Customers", "Work/Customers/Acme"]);
    expect(throwsKey(() => planLabelRename(labels, "Label_1", "travel"))).toBe("errors.folder.nameTaken");
    // a sublabel's new name taken by another label: refused before any request
    expect(throwsKey(() => planLabelRename([...labels, { id: "Label_7", name: "Job/Archive", type: "user" }], "Label_1", "Job"))).toBe("errors.folder.nameTaken");
    // a case change of its own name is no collision
    expect(planLabelRename(labels, "Label_6", "travel")[0]!.to).toBe("travel");
  });

  it("deletes a label with its sublabels, deepest first", () => {
    expect(planLabelDelete(labels, "Label_1").map((l) => l.id)).toEqual(["Label_3", "Label_2", "Label_4", "Label_1"]);
    expect(throwsKey(() => planLabelDelete(labels, "INBOX"))).toBe("errors.folder.standard");
  });
});

describe("the demo's folders", () => {
  const gmail = [{ key: "Label_21", path: ["Proyectos"], selectable: true }, { key: "Label_22", path: ["Proyectos", "Rediseño web"], selectable: true }, { key: "Label_23", path: ["Equipo"], selectable: true }];
  const imap = [{ key: "Clientes antiguos", path: ["Clientes antiguos"], selectable: true }, { key: "Facturación", path: ["Facturación"], selectable: false }, { key: "Facturación/2026", path: ["Facturación", "2026"], selectable: true }];

  it("Gmail-like: a new label id; a rename keeps keys and renames the subtree; a delete takes it", () => {
    expect(demoFolderChange(gmail, true, { create: { parent: "Label_21", name: "Marca" } })).toMatchObject({ key: "Label_24", folders: [...gmail, { key: "Label_24", path: ["Proyectos", "Marca"], selectable: true }] });
    expect(demoFolderChange(gmail, true, { rename: { key: "Label_21", name: "Trabajo" } })).toEqual({
      folders: [{ key: "Label_21", path: ["Trabajo"], selectable: true }, { key: "Label_22", path: ["Trabajo", "Rediseño web"], selectable: true }, gmail[2]],
      renamed: [{ from: "Label_21", to: "Label_21" }, { from: "Label_22", to: "Label_22" }],
    });
    expect(demoFolderChange(gmail, true, { delete: { key: "Label_21" } })).toEqual({ folders: [gmail[2]], deleted: ["Label_21", "Label_22"] });
    expect(throwsKey(() => demoFolderChange(gmail, true, { create: { parent: null, name: "equipo" } }))).toBe("errors.folder.nameTaken");
    // never a deleted label's id: past the highest ever given (Codex code review round 19 #4)
    expect(demoFolderChange([gmail[2]!], true, { create: { parent: null, name: "Viajes" } }, 24).key).toBe("Label_25");
    expect(demoFolderChange(gmail, true, { create: { parent: null, name: "Viajes" } }, 2).key).toBe("Label_24");
  });

  it("IMAP-like: keys are paths, so a rename moves the subtree's keys", () => {
    expect(demoFolderChange(imap, false, { create: { parent: "Facturación", name: "2027" } }).key).toBe("Facturación/2027");
    expect(demoFolderChange(imap, false, { rename: { key: "Facturación", name: "Facturas" } })).toMatchObject({
      renamed: [{ from: "Facturación", to: "Facturas" }, { from: "Facturación/2026", to: "Facturas/2026" }],
      folders: [imap[0], { key: "Facturas", path: ["Facturas"], selectable: false }, { key: "Facturas/2026", path: ["Facturas", "2026"], selectable: true }],
    });
    expect(throwsKey(() => demoFolderChange(imap, false, { rename: { key: "Facturación/2026", name: "a/b" } }))).toBe("errors.folder.nameSeparator");
  });
});

describe("Gmail label changes on the wire", () => {
  function gmail(initial: { id: string; name: string; type: string }[], o: { refuse?: (method: string, id: string) => number | null } = {}) {
    const labels = new Map(initial.map((l) => [l.id, { ...l }]));
    const requests: string[] = [];
    let next = 100;
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^.*\/users\/me/, "");
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (path === "/labels" && method === "GET") return Response.json({ labels: [...labels.values()] });
      const id = decodeURIComponent(path.split("/")[2] ?? "");
      const status = o.refuse?.(method, id);
      if (status) return Response.json({ error: { code: status, status: status === 409 ? "ALREADY_EXISTS" : "FAILED_PRECONDITION" } }, { status });
      if (path === "/labels" && method === "POST") {
        const body = JSON.parse(String(init!.body)) as { name: string };
        const label = { id: `Label_${next++}`, name: body.name, type: "user" };
        labels.set(label.id, label);
        return Response.json(label);
      }
      if (method === "PATCH") {
        labels.get(id)!.name = (JSON.parse(String(init!.body)) as { name: string }).name;
        return Response.json(labels.get(id));
      }
      if (method === "DELETE") {
        labels.delete(id);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as typeof globalThis.fetch;
    const ctx = { account: { id: 1, email: "me@gmail.com" }, config: {}, fetch, store: {} } as unknown as ProviderContext;
    const provider = createGmailApiProvider(ctx, { tokens: { get: async () => "token", invalidate() {} }, buildRaw: async () => new Uint8Array() });
    return { provider, labels, requests };
  }
  const catalog = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Work", type: "user" },
    { id: "Label_2", name: "Work/Clients", type: "user" },
    { id: "Label_3", name: "Work/Clients/Acme", type: "user" },
  ];

  it("creates a sublabel under its parent's name and answers with the labels as Gmail lists them now", async () => {
    const g = gmail(catalog);
    const r = await g.provider.createFolder!({ parent: "Label_2", name: "Globex", folders: [] });
    expect(r.key).toBe("Label_100");
    expect(r.folders.find((f) => f.key === "Label_100")).toEqual({ key: "Label_100", path: ["Work", "Clients", "Globex"], selectable: true });
    expect(g.requests).toEqual(["GET /labels", "POST /labels", "GET /labels"]);
  });

  it("a name Gmail says is taken (409) reads as taken; a collision found first sends nothing", async () => {
    const g = gmail(catalog, { refuse: (method) => (method === "POST" ? 409 : null) });
    await expect(g.provider.createFolder!({ parent: null, name: "Receipts", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.nameTaken" } });
    const h = gmail(catalog);
    await expect(h.provider.createFolder!({ parent: null, name: "work", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.nameTaken" } });
    expect(h.requests).toEqual(["GET /labels"]);
  });

  it("renames a label and its sublabels (PATCH each; keys stay)", async () => {
    const g = gmail(catalog);
    const r = await g.provider.renameFolder!({ key: "Label_1", name: "Job", folders: [] });
    expect([...g.labels.values()].map((l) => l.name)).toEqual(["INBOX", "Job", "Job/Clients", "Job/Clients/Acme"]);
    expect(r.renamed).toEqual([{ from: "Label_1", to: "Label_1" }, { from: "Label_2", to: "Label_2" }, { from: "Label_3", to: "Label_3" }]);
    expect(r.partial).toBeUndefined();
    expect(r.folders.map((f) => f.path.join("/"))).toEqual(["Job", "Job/Clients", "Job/Clients/Acme"]);
  });

  it("a refusal midway stops the rest, reads /labels again and says what didn't happen", async () => {
    const g = gmail(catalog, { refuse: (method, id) => (method === "PATCH" && id === "Label_3" ? 400 : null) });
    const r = await g.provider.renameFolder!({ key: "Label_1", name: "Job", folders: [] });
    expect(r.renamed).toEqual([{ from: "Label_1", to: "Label_1" }, { from: "Label_2", to: "Label_2" }]);
    expect(r.partial?.i18n).toMatchObject({ key: "errors.folder.partialRename", params: { done: 2, total: 3, name: "Acme", reason: "FAILED_PRECONDITION" } });
    // the truth, as Gmail lists it after the failure
    expect(r.folders.map((f) => f.path.join("/"))).toEqual(["Job", "Job/Clients", "Work/Clients/Acme"]);
    expect(g.requests.at(-1)).toBe("GET /labels");
  });

  it("a refusal of the first request is the answer (nothing changed)", async () => {
    const g = gmail(catalog, { refuse: (method) => (method === "DELETE" ? 400 : null) });
    await expect(g.provider.deleteFolder!({ key: "Label_1", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.refused", params: { server: "Gmail", reason: "FAILED_PRECONDITION" } } });
    expect(g.labels.size).toBe(4);
  });

  it("a change's own read of /labels isn't taken for the stored list: the next pass reads them, and only a stored read is fresh (Codex code review round 23 #3)", async () => {
    const g = gmail(catalog);
    const stored: string[][] = [];
    const sink = { signal: new AbortController().signal, setFolders: async (f: { path: string[] }[]) => { stored.push(f.map((x) => x.path.join("/"))); } } as unknown as SyncSink;
    await g.provider.renameFolder!({ key: "Label_1", name: "Job", folders: [] });
    // the backend's write of that list failed: the pass after reads what's true
    await g.provider.folders!(sink);
    expect(g.requests.at(-1)).toBe("GET /labels");
    expect(stored).toEqual([["Job", "Job/Clients", "Job/Clients/Acme"]]);
    // stored: fresh until it may have changed
    const before = g.requests.length;
    await g.provider.folders!(sink);
    expect(g.requests).toHaveLength(before);
  });

  it("deletes a label and its sublabels, deepest first; a system label is refused before any request", async () => {
    const g = gmail(catalog);
    const r = await g.provider.deleteFolder!({ key: "Label_1", folders: [] });
    expect(r.deleted).toEqual(["Label_3", "Label_2", "Label_1"]);
    expect(g.requests.filter((x) => x.startsWith("DELETE"))).toEqual(["DELETE /labels/Label_3", "DELETE /labels/Label_2", "DELETE /labels/Label_1"]);
    expect(r.folders).toEqual([]);
    await expect(g.provider.deleteFolder!({ key: "INBOX", folders: [] })).rejects.toMatchObject({ i18n: { key: "errors.folder.standard" } });
  });
});

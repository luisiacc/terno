import type { Address, AttachmentInfo, MessageDetail, ThreadDetail } from "@terno/core";
import { describe, expect, it } from "vitest";
import { identitiesIn } from "./compose-fields";
import { firstName, threadFiles, threadPeople } from "./thread-overview";

let next = 1;
const msg = (from: Address, to: Address[], o: Partial<MessageDetail> = {}): MessageDetail =>
  ({ id: next++, accountId: 1, from, to, cc: [], isSent: false, listId: null, attachments: [], ...o }) as MessageDetail;
const file = (id: number, filename: string, size = 1000, assetId?: string): AttachmentInfo => ({ id, filename, size, mime: "application/pdf", ...(assetId ? { assetId } : {}) });
const me = { name: "Luis Cordero", email: "luis@gmail.com" };
const ana = { name: "Ana López", email: "ana@acme.studio" };
const ben = { name: "Ben Ito", email: "ben@acme.studio" };
const people = (messages: MessageDetail[], accounts = [me.email]) => threadPeople(messages, identitiesIn({ messages } as ThreadDetail, accounts));

describe("threadPeople (plan 177)", () => {
  it("lists who wrote first, in the order they wrote, then who was only written to, without the user", () => {
    const cara = { name: "Cara", email: "cara@acme.studio" };
    const p = people([msg(ben, [me, ana]), msg(ana, [me, ben], { cc: [cara] }), msg(me, [ben], { isSent: true })]);
    expect(p.map((x) => x.short)).toEqual(["Ben", "Ana", "Cara"]);
    expect(p.map((x) => x.wrote)).toEqual([true, true, false]);
  });

  it("leaves out every one of the user's addresses as Reply does: other accounts, +tags, Gmail's dots, a sent alias", () => {
    const alias = { name: "Luis", email: "luis@cordero.dev" };
    const p = people(
      [msg(ana, [{ name: "", email: "Lu.is+work@gmail.com" }, { name: "Luis", email: "luis@work.example" }]), msg(alias, [ana], { isSent: true })],
      [me.email, "luis@work.example"],
    );
    expect(p.map((x) => x.email)).toEqual(["ana@acme.studio"]);
  });

  it("names someone once by address, with the name they sign with over the one others wrote", () => {
    const p = people([msg(ben, [{ name: "", email: "ANA@acme.studio" }]), msg(ben, [{ name: "ana (finance)", email: "ana@acme.studio" }]), msg(ana, [ben])]);
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.email.toLowerCase() === "ana@acme.studio")!.name).toBe("Ana López");
  });

  it("keeps the newest message each one wrote, for the avatar rules, even after they were first only written to", () => {
    const list = msg(ben, [ana], { listId: "team.acme.studio" });
    const p = people([msg(ana, [ben]), list]);
    expect(p.find((x) => x.email === ben.email)!.lastSent).toBe(list);
  });

  it("says first names; full names when two share one; addresses when the full names match too; the address with no name", () => {
    const p = people([msg(ana, [{ name: "Ana Ruiz", email: "ruiz@x.test" }, { name: "Ben Ito", email: "ben2@x.test" }, ben, { name: "", email: "noname@x.test" }])]);
    expect(p.map((x) => x.short)).toEqual(["Ana López", "Ana Ruiz", "ben2@x.test", "ben@acme.studio", "noname@x.test"]);
  });

  it("nobody but the user: no one", () => {
    expect(people([msg(me, [me], { isSent: true }), msg(me, [me], { isSent: true })])).toEqual([]);
  });
});

describe("firstName", () => {
  it("reads the given name", () => {
    expect(firstName("Ana López (Acme)", "a@x")).toBe("Ana");
    expect(firstName("Doe, John", "a@x")).toBe("John");
    // surnames of several words, and a company's ending that isn't a given name
    expect(firstName("García López, Ana", "a@x")).toBe("Ana");
    expect(firstName("van der Meer, Jan", "a@x")).toBe("Jan");
    expect(firstName("Acme, Inc.", "a@x")).toBe("Acme");
    expect(firstName("Northwind, LLC", "a@x")).toBe("Northwind");
    expect(firstName("a@x", "a@x")).toBe("a@x");
    expect(firstName("", "a@x")).toBe("a@x");
  });
});

describe("threadFiles (plan 177)", () => {
  it("every file of every message, oldest first, each with its own message; the same name and size twice stays twice", () => {
    const a = msg(ana, [me], { attachments: [file(1, "report.pdf", 500, "x1"), file(2, "logo.png")] });
    const b = msg(me, [ana], { isSent: true });
    const c = msg(ana, [me], { attachments: [file(3, "report.pdf", 500)] });
    const files = threadFiles([a, b, c]);
    expect(files.map((f) => [f.message.id, f.attachment.id])).toEqual([[a.id, 1], [a.id, 2], [c.id, 3]]);
    // the older copy keeps its cache, the newer its retry
    expect(files[0]!.attachment.assetId).toBe("x1");
    expect(files[2]!.attachment.assetId).toBeUndefined();
  });
});

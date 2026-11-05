import type { IncomingMessage, MailStore } from "@terno/store";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface AnyOfHarness {
  store: MailStore;
  search(query: string): Promise<{ items: readonly { id: number; subject: string }[]; strategy: string }>;
  ready(): Promise<void>;
  close(): Promise<void>;
  /** the store captures a large body in parts here (IndexedDB does it in a Worker, which this runtime lacks) */
  captures: boolean;
}

const person = (email: string, name = "") => ({ name, email });
const BIG = "big-studio";

/**
 * Plan 140, on what a real store holds, on each path a search takes: the
 * index, FTS5, the scan. Each thread is named by its subject, and each exists
 * to fail an implementation that gets one thing wrong: a lookalike address, a
 * recipient field left out, a mention in a body, two alternatives ANDed.
 */
const MAIL: readonly Omit<Partial<IncomingMessage>, "accountId">[] = [
  { subject: "from-ana", from: person("ana@acme.test", "Ana Ruiz") },
  { subject: "to-ana", to: [person("ana@acme.test", "Ana Ruiz")] },
  { subject: "cc-ana", cc: [person("ana@acme.test")] },
  { subject: "bcc-ana", bcc: [person("ana@acme.test")], isSent: true },
  { subject: "upper-ana", from: person("ANA@ACME.TEST") },
  { subject: "named-recipients", to: [person("zoe@else.test", "Zoe Díaz"), person("ana@acme.test", "Ana, de ventas"), person("yan@else.test", "Yan")] },
  { subject: "lookalike-before", from: person("maria.ana@acme.test") },
  { subject: "lookalike-after", to: [person("ana@acme.test.evil.example")] },
  { subject: "lookalike-domain", to: [person("ana@acme.testing")] },
  { subject: "mention-in-body", bodyText: "Write to ana@acme.test for the invoice" },
  { subject: "from-bob", from: person("bob@globex.test") },
  { subject: "to-both", to: [person("ana@acme.test"), person("bob@globex.test")] },
  { subject: "word-test", bodyText: "visit nova.test today", from: person("c@else.test") },
  { subject: "word-studio", bodyText: "visit nova.studio today", from: person("d@else.test") },
  { subject: "word-neither", bodyText: "visit nova.example today", from: person("e@else.test") },
  { subject: "word-apart", bodyText: "nova went to the test", from: person("f@else.test") },
  { subject: "subject nova.test", from: person("g@else.test") },
  { subject: "factura-nova", bodyText: "factura de nova.test", from: person("h@else.test") },
  { subject: "factura-sola", bodyText: "factura de nadie", from: person("i@else.test") },
  { subject: "ana-factura", bodyText: "la factura", from: person("ana@acme.test") },
  { subject: "amount", bodyText: "total 1,000 pesos", from: person("j@else.test") },
  { subject: "amount-apart", bodyText: "1 of 1000 and 000", from: person("k@else.test") },
  // large enough to be captured in parts: the FTS path's segmented form, and the prepared body tests for a group
  { subject: "big-studio", bodyText: "visit nova.studio today ".repeat(5000), from: person("l@else.test") },
];

const CASES: readonly [query: string, subjects: readonly string[]][] = [
  // a comma is either
  ["nova.test,nova.studio ", ["word-test", "word-studio", "big-studio", "subject nova.test", "factura-nova"]],
  ["nova.test, nova.studio ", ["word-test", "word-studio", "big-studio", "subject nova.test", "factura-nova"]],
  ["nova.test,nova.stu", ["word-test", "word-studio", "big-studio", "subject nova.test", "factura-nova"]],
  ["nova.test nova.studio ", []],
  ["factura nova.test,nova.studio ", ["factura-nova"]],
  ["nova.test,nova.studio -factura ", ["word-test", "word-studio", "big-studio", "subject nova.test"]],
  ["subject:nova.test,factura-sola ", ["subject nova.test", "factura-sola"]],
  // a domain is ordinary text, so it finds the people there too
  ["globex.test,nowhere.test ", ["from-bob", "to-both"]],
  ["from:bob@globex.test,c@else.test ", ["from-bob", "word-test"]],
  ["from:bob@globex.test,subject:factura-sola ", ["from-bob", "factura-sola"]],
  ["from:bob@globex.test,zzqq ", ["from-bob"]],
  ["zzqq,yyqq ", []],
  ["-nova.test,nova.studio word ", ["word-neither", "word-apart"]],
  ["1,000 ", ["amount"]],
  // an address is that address: sender, To, Cc or Bcc, in any case, never a lookalike, never a mention
  ["ana@acme.test ", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "to-both", "ana-factura"]],
  ["ANA@Acme.Test ", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "to-both", "ana-factura"]],
  ["<ana@acme.test> ", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "to-both", "ana-factura"]],
  // one of them, with or without a comma
  ["ana@acme.test bob@globex.test ", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "to-both", "ana-factura", "from-bob"]],
  ["ana@acme.test,bob@globex.test ", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "to-both", "ana-factura", "from-bob"]],
  ["bob@globex.test nobody@nowhere.example ", ["from-bob", "to-both"]],
  ["nobody@nowhere.example ", []],
  // with the rest of the query, on the same message
  ["ana@acme.test factura ", ["ana-factura"]],
  ["ana@acme.test bob@globex.test factura ", ["ana-factura"]],
  ["bob@globex.test,factura-sola ", ["from-bob", "to-both", "factura-sola"]],
  // quotes ask for the text, anywhere
  ['"ana@acme.test" ', ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "lookalike-before", "lookalike-after", "to-both", "mention-in-body", "ana-factura"]],
  // still typing: a prefix of an address, until a space or a comma commits it
  ["bob@", ["from-bob", "to-both"]],
  ["bob@glo", ["from-bob", "to-both"]],
  ["maria.ana@acme.te", ["lookalike-before"]],
  ["ana@acme.test", ["from-ana", "to-ana", "cc-ana", "bcc-ana", "upper-ana", "named-recipients", "lookalike-after", "lookalike-domain", "to-both", "ana-factura"]],
  ["bob@globex.test,ana@acme.testi", ["from-bob", "to-both", "lookalike-domain"]],
];

export function defineAnyOfSearch(name: string, open: () => Promise<AnyOfHarness>): void {
  describe(`any of and addresses: ${name}`, () => {
    let h: AnyOfHarness;
    beforeAll(async () => {
      h = await open();
      const [account] = await withAccounts(h.store, 1);
      await ingest(h.store, MAIL.filter((m) => h.captures || m.subject !== BIG).map((m) => msg({ accountId: account!, bodyText: "nothing here", ...m })));
      await h.ready();
    });
    afterAll(() => h.close());

    it.each(CASES)("%s", async (query, subjects) => {
      const page = await h.search(query);
      expect(page.items.map((t) => t.subject).sort()).toEqual(subjects.filter((x) => h.captures || x !== BIG).sort());
    });
  });
}

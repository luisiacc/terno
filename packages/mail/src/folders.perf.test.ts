/**
 * Plan 65 (Codex R17): a provider's catalog of 10,000 folders, names of 225 characters sharing a long prefix, becomes
 * the folder list within a small part of a frame on the backend's loop (no sort there: the sidebar draws by name).
 */
import { FOLDER_NAME_MAX } from "@terno/core";
import { expect, it } from "vitest";
import { labelFolders } from "./gmail-api";
import { addAll, customFolders, gatherPlaces, joinGroups, journalUnion, partitionKnown, planSteps, planTellApart, readTwins, reconcileMessages, storedIds } from "./imap";

const prefix = "Proyectos y clientes de la oficina central — ".repeat(5);
const name = (i: number) => `${prefix}${String((i * 7919) % 10_000).padStart(5, "0")}`.slice(-FOLDER_NAME_MAX);
const best = (fn: () => unknown) => {
  fn();
  const runs = [0, 1, 2].map(() => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  });
  return Math.min(...runs);
};

it("Gmail: 10,000 long labels in under 8 ms", () => {
  const labels = Array.from({ length: 10_000 }, (_, i) => ({ id: `Label_${i}`, name: name(i), type: "user" }));
  expect(labelFolders(labels)).toHaveLength(10_000);
  expect(best(() => labelFolders(labels))).toBeLessThan(8);
});

it("IMAP: 10,000 long folders in under 8 ms", () => {
  type Listed = Parameters<typeof customFolders>[0][number];
  const list = Array.from({ length: 10_000 }, (_, i) => ({ path: name(i), name: name(i), delimiter: "/", flags: new Set<string>(), listed: true, subscribed: true }) as unknown as Listed);
  expect(customFolders(list, {})).toHaveLength(10_000);
  expect(best(() => customFolders(list, {}))).toBeLessThan(8);
});

it("Codex R21, R32: 150,000 held-back messages sharing 150,000 twins: their places gathered once, the loop never held a frame", async () => {
  const shared = Array.from({ length: 150_000 }, (_, i) => i + 1);
  const list = Array.from({ length: 150_000 }, () => ({ candidates: shared }));
  const of = async (ids: number[]) => ids.map((id) => ({ message_id: id, mailbox: "Z", uid: id, uidvalidity: 1 }));
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const r = await gatherPlaces(list, of);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(r.places.size).toBe(150_000);
    expect(r.byMailbox.get("Z")!.uids.size).toBe(150_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R30: 5,000 copies of a Message-ID with 5,000 placed twins are planned in linear time, under 20 ms", () => {
  const candidates = Array.from({ length: 5000 }, (_, i) => i + 1);
  const places = new Map(candidates.map((id) => [id, [{ mailbox: "Z", uid: id }]]));
  const present = new Set(candidates.map((id) => `Z\u0000${id}`));
  const list = Array.from({ length: 5000 }, () => ({ candidates, path: "A", attachTo: 1, idCopy: true, old: false }));
  const plan = planTellApart(list, places, present);
  // each twin gains its place in A once; nothing is a copy of its own, nothing moved
  expect(plan.placed.map((p) => p.id)).toEqual(candidates);
  expect(plan.placed.every((p) => !p.moved)).toBe(true);
  expect(plan.copies).toHaveLength(0);
  expect(best(() => planTellApart(list, places, present))).toBeLessThan(20);
});

it("Codex R31: 150,000 held-back copies are planned a step at a time: 99% of steps under 2 ms, none over a frame", () => {
  const candidates = Array.from({ length: 150_000 }, (_, i) => i + 1);
  const places = new Map(candidates.map((id) => [id, [{ mailbox: "Z", uid: id }]]));
  const present = new Set(candidates.map((id) => `Z\u0000${id}`));
  const list = Array.from({ length: 150_000 }, () => ({ candidates, path: "A", attachTo: 1, idCopy: true, old: false }));
  // (a step now and then is a collection or a set growing past a power of two: what's ours is every other step)
  const steps = () => {
    const it = planSteps(list, places, present);
    const times: number[] = [];
    for (let r: IteratorResult<void, unknown> | null = null; !r?.done; ) {
      const t0 = performance.now();
      r = it.next();
      times.push(performance.now() - t0);
    }
    return times.sort((a, b) => a - b);
  };
  steps();
  const runs = [steps(), steps(), steps()];
  const p99 = Math.min(...runs.map((t) => t[Math.floor(t.length * 0.99)]!));
  expect(runs[0]!.length).toBeGreaterThan(100);
  expect(p99).toBeLessThan(2);
  expect(Math.min(...runs.map((t) => t.at(-1)!))).toBeLessThan(16);
  expect(planTellApart(list, places, present).placed).toHaveLength(150_000);
});

it("Codex R33: 50,000 copies just written are looked up again without holding the loop a frame", async () => {
  const keys = Array.from({ length: 50_000 }, (_, i) => `nomid:key#A:1:${i}`);
  const rows = new Map(keys.map((k, i) => [k, { id: i + 1 }]));
  // a synchronous store behind a resolved promise (as SQLite's is): no turn of its own
  const lookup = async (key: string) => {
    let spin = 0;
    for (let j = 0; j < 3000; j++) spin += j;
    return spin >= 0 ? rows.get(key) : undefined;
  };
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const ids = await storedIds(keys, lookup);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(ids).toHaveLength(50_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R35: 50,000 messages just written join one twin group in linear time, the loop never held a frame", async () => {
  const run = async () => {
    const group = [1, 2, 3];
    const groups = new Map([["k", group]]);
    const keys = Array.from({ length: 50_000 }, () => "k");
    const ids = Array.from({ length: 50_000 }, (_, i) => i + 10);
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const t0 = performance.now();
    await joinGroups(groups, keys, ids);
    const total = performance.now() - t0;
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(group).toHaveLength(50_003);
    expect(group.every((id, i) => i === 0 || id > group[i - 1]!)).toBe(true);
    return { worst, total };
  };
  await run();
  const runs = [await run(), await run(), await run()];
  expect(Math.min(...runs.map((r) => r.worst))).toBeLessThan(16);
  expect(Math.min(...runs.map((r) => r.total))).toBeLessThan(100);
});

it("Codex R36: an initial import of 500,000 identical envelopes joins its group a step at a time, never a frame", async () => {
  const run = async (older: boolean) => {
    const group = older ? Array.from({ length: 250_000 }, (_, i) => 2 * i + 2) : [1, 2, 3];
    const groups = new Map([["k", group]]);
    const keys = Array.from({ length: older ? 250_000 : 500_000 }, () => "k");
    const ids = older ? Array.from({ length: 250_000 }, (_, i) => 2 * i + 1) : Array.from({ length: 500_000 }, (_, i) => i + 10);
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    await joinGroups(groups, keys, ids);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(group).toHaveLength(older ? 500_000 : 500_003);
    expect(group.every((id, i) => i === 0 || id > group[i - 1]!)).toBe(true);
    return worst;
  };
  for (const older of [false, true]) {
    await run(older);
    expect(Math.min(await run(older), await run(older), await run(older))).toBeLessThan(16);
  }
});

it("Codex R39: reading 500,000 stored twins of one envelope never holds the loop a frame", async () => {
  // a synchronous store behind a resolved promise (as SQLite's is): a page of 500 costs what an indexed read does
  const page = async (after: number) => {
    let spin = 0;
    for (let j = 0; j < 100_000; j++) spin += j;
    return spin < 0 || after >= 500_000 ? [] : Array.from({ length: Math.min(500, 500_000 - after) }, (_, i) => after + i + 1);
  };
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const group = await readTwins(page);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(group).toHaveLength(500_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R42: a reset's 500,000 ids gathered into its sets without holding the loop a frame", async () => {
  const located = Array.from({ length: 500_000 }, (_, i) => i + 1);
  const pending = Array.from({ length: 200_000 }, (_, i) => 2 * i + 1);
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const ids = new Set<number>();
    await addAll(ids, pending);
    await addAll(ids, located);
    const journaled = new Set<number>();
    await addAll(journaled, pending);
    await addAll(journaled, ids);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(ids.size).toBe(500_000);
    expect(journaled.size).toBe(500_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R44: a big expunge's 500,000 ids journaled onto 200,000 without holding the loop a frame", async () => {
  const journaled = Array.from({ length: 200_000 }, (_, i) => 2 * i + 1);
  const ids = Array.from({ length: 500_000 }, (_, i) => i + 1);
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const next = await journalUnion(journaled, ids);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(next).toHaveLength(500_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
  expect(await journalUnion([1, 2], [2, 1])).toBeNull();
});

it("Codex R46: 10,000 IMAP folders nested twenty levels deep under shared groups within a frame (most of it the 210,000 names drawn)", () => {
  type Listed = Parameters<typeof customFolders>[0][number];
  const levels = Array.from({ length: 20 }, (_, i) => `Nivel ${String(i).padStart(2, "0")} de la jerarquía común`);
  const parents = levels.join("/");
  // the twenty shared levels are groups (\Noselect), each kept: something real is under it
  const groups = levels.map((_, i) => ({ path: levels.slice(0, i + 1).join("/"), name: levels[i]!, delimiter: "/", flags: new Set(["\\Noselect"]), listed: true, subscribed: true }) as unknown as Listed);
  const leaves = Array.from({ length: 9_980 }, (_, i) => ({ path: `${parents}/Hoja ${i}`, name: `Hoja ${i}`, delimiter: "/", flags: new Set<string>(), listed: true, subscribed: true }) as unknown as Listed);
  const list = [...groups, ...leaves];
  const out = customFolders(list, {});
  expect(out).toHaveLength(10_000);
  expect(out.filter((f) => !f.selectable)).toHaveLength(20);
  expect(best(() => customFolders(list, {}))).toBeLessThan(16);
});

it("Codex R46: a sweep's 500,000 stored locations split against the server's without holding the loop a frame", async () => {
  const known = Array.from({ length: 500_000 }, (_, i) => ({ uid: i + 1, message_id: i + 1, flags: "[]" }));
  const server = new Set(Array.from({ length: 250_000 }, (_, i) => 2 * i + 1));
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    const r = await partitionKnown(known, server);
    clearInterval(tick);
    worst = Math.max(worst, performance.now() - last);
    expect(r.gone).toHaveLength(250_000);
    expect(r.stillThere).toHaveLength(250_000);
    expect(r.byUid.size).toBe(500_000);
    return worst;
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R49: reconciling 50,000 messages (a renamed folder's) never holds the loop a frame", async () => {
  const ids = Array.from({ length: 50_000 }, (_, i) => i + 1);
  // synchronous stores behind resolved promises (as SQLite's are), a chunk of 500 costing what its reads do
  const spin = (n: number) => {
    let x = 0;
    for (let j = 0; j < n; j++) x += j;
    return x >= 0;
  };
  const deps = {
    of: async (chunk: number[]) => (spin(300_000) ? chunk.map((id) => ({ message_id: id, mailbox: "A", flags: "[]" })) : []),
    providerIds: async (chunk: number[]) => new Map(chunk.map((id) => [id, `k${id}`] as const)),
    state: () => ({ isRead: false }) as never,
    updateFlags: async () => void spin(200_000),
    removeMessages: async () => {},
  };
  const stall = async () => {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    await reconcileMessages(ids, deps);
    clearInterval(tick);
    return Math.max(worst, performance.now() - last);
  };
  await stall();
  expect(Math.min(await stall(), await stall(), await stall())).toBeLessThan(16);
});

it("Codex R52: the sync cursor at its largest (every journal full) is written and read back within a frame", () => {
  const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i);
  const cursor = { mailboxes: { INBOX: { uidvalidity: 1, uidnext: 2 } }, unlocated: ids(200_000, 1), orphans: ids(100_000, 300_000), resetPending: { A: ids(100_000, 500_000), B: ids(100_000, 700_000) }, overflow: true };
  expect(best(() => JSON.parse(JSON.stringify(cursor)))).toBeLessThan(16);
});

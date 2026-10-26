import type { PlatformFiles } from "@terno/store";
import { describe, expect, it } from "vitest";
import { pngBytes } from "../test/icons-fixtures";
import { IconCache } from "./cache";

function memFiles(): PlatformFiles & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    read: async (p) => map.get(p) ?? null,
    replace: async (p, b) => void map.set(p, b),
    remove: async (p) => void map.delete(p),
  };
}

const icon = (px: number, color = 1) => ({ mime: "image/png" as const, bytes: pngBytes(px, px, [color, 2, 3, 255]), px, full: false });

function cache(o: Partial<ConstructorParameters<typeof IconCache>[0]> & { clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: 1000 };
  return { clock, c: new IconCache({ base: "/p/terno.db", maxBytes: 1 << 20, maxEntries: 100, slots: 50, now: () => clock.t, writeDelayMs: 0, ...o }) };
}

describe("the icon cache (plan 22)", () => {
  it("keeps icons, verifies their bytes on read, and survives a restart through the index", async () => {
    const files = memFiles();
    const { c } = cache({ files });
    await c.load();
    const a = icon(32);
    await c.put("d:netflix.com", a, 1000);
    expect(c.get("d:netflix.com")).toMatchObject({ kind: "icon", px: 32, slot: 0 });
    expect(await c.read("d:netflix.com")).toEqual(a.bytes);
    await c.flush();
    expect(files.map.has("/p/terno.db.icons/0")).toBe(true);
    expect(files.map.has("/p/terno.db.icons.json")).toBe(true);
    const { c: again } = cache({ files });
    await again.load();
    expect(await again.read("d:netflix.com")).toEqual(a.bytes);
    // a slot overwritten behind the index's back is a miss, not the wrong picture
    files.map.set("/p/terno.db.icons/0", pngBytes(48));
    expect(await again.read("d:netflix.com")).toBeNull();
    expect(again.get("d:netflix.com")).toBeUndefined();
  });

  it("LRU by bytes and by count: negative entries go first, then the least recently used", async () => {
    const one = icon(32).bytes.length;
    const { clock, c } = cache({ maxBytes: one * 2 + 10, maxEntries: 4, base: null });
    await c.put("d:a.com", icon(32, 1), 0);
    clock.t++;
    await c.put("d:b.com", icon(32, 2), 0);
    clock.t++;
    c.get("d:a.com"); // a is used again: b is now the oldest
    clock.t++;
    c.negative("d:none.com", clock.t + 10_000);
    clock.t++;
    await c.put("d:c.com", icon(32, 3), 0);
    // room for c's bytes: the negative entry went first, then b (least recently used)
    expect([...c.keys()].sort()).toEqual(["d:a.com", "d:c.com"]);
    expect(c.size.bytes).toBeLessThanOrEqual(one * 2 + 10);
    for (const d of ["x", "y", "z"]) {
      clock.t++;
      c.negative(`d:${d}.com`, clock.t + 10_000);
    }
    // count bound (4): the oldest negative made room for the newest
    expect([...c.keys()].sort()).toEqual(["d:a.com", "d:c.com", "d:y.com", "d:z.com"]);
  });

  it("negative entries expire; timeouts are counted on them", async () => {
    const { clock, c } = cache({ base: null });
    c.negative("d:slow.com", clock.t, 1);
    expect(c.get("d:slow.com")).toBeUndefined();
    expect(c.timeouts("d:slow.com")).toBe(1);
    c.negative("d:none.com", clock.t + 100);
    expect(c.get("d:none.com")).toMatchObject({ kind: "none" });
    clock.t += 101;
    expect(c.get("d:none.com")).toBeUndefined();
  });

  it("disk stays bounded when the index is lost: slots are reused from 0, never new names; forgetting removes them all", async () => {
    const files = memFiles();
    for (let round = 0; round < 3; round++) {
      files.map.delete("/p/terno.db.icons.json");
      const { c } = cache({ files, slots: 5 });
      await c.load();
      for (let i = 0; i < 8; i++) await c.put(`d:r${round}-${i}.com`, icon(16 + i, round), 0);
      await c.flush();
    }
    const slots = [...files.map.keys()].filter((k) => k.startsWith("/p/terno.db.icons/"));
    expect(slots.sort()).toEqual([0, 1, 2, 3, 4].map((n) => `/p/terno.db.icons/${n}`));
    // a corrupt index starts empty
    files.map.set("/p/terno.db.icons.json", new TextEncoder().encode("{not json"));
    const { c } = cache({ files, slots: 5 });
    await c.load();
    expect(c.size.entries).toBe(0);
    await c.put("d:x.com", icon(20), 0);
    await c.clear();
    expect([...files.map.keys()]).toEqual([]);
  });
});

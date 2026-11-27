import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusSources, DemoManifest } from "./types";

/**
 * Plan 292: reading the written demo mailbox's sources from disk (Node only, `@terno/mock-data/corpus-node`). The
 * desktop's dev demo reads them once, when it seeds an empty profile; tests read them from the repo.
 */

/** The committed sources' folder, for tests and scripts run from the repo (a bundled app is handed its path instead). */
export const DEMO_CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../demo-corpus");

/** FNV-1a over the files' names and contents: the corpus's revision, recorded with each seed. */
function revisionOf(files: { name: string; text: string }[]): string {
  let h = 0x811c9dc5;
  for (const f of files) for (const s of [f.name, f.text]) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function readCorpusSources(dir: string): { sources: CorpusSources; manifest: DemoManifest | null; revision: string } {
  const list = (sub: string, keep: (f: string) => boolean) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter(keep).sort().map((f) => `${sub}/${f}`) : []);
  const names = ["world.json", "lists.json", ...(existsSync(join(dir, "demo.json")) ? ["demo.json"] : []), ...list("seeds", (f) => /^batch-\d+\.json$/.test(f)), ...list("threads", (f) => /^batch-\d+\.json$/.test(f)), ...list("bulk", (f) => f.endsWith(".json"))];
  const files = names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const parsed = new Map(files.map((f) => [f.name, JSON.parse(f.text) as unknown]));
  const sources: CorpusSources = {
    world: parsed.get("world.json") as CorpusSources["world"],
    lists: parsed.get("lists.json") as CorpusSources["lists"],
    threads: names.filter((n) => n.startsWith("threads/")).flatMap((n) => parsed.get(n) as CorpusSources["threads"]),
    bulk: names
      .filter((n) => n.startsWith("bulk/") && n !== "bulk/spam.json")
      .flatMap((n) => {
        const v = parsed.get(n) as CorpusSources["bulk"] | CorpusSources["bulk"][number];
        return Array.isArray(v) ? v : [v];
      }),
    spam: (parsed.get("bulk/spam.json") as CorpusSources["spam"] | undefined) ?? [],
    // every brief must have its thread: a batch file gone is caught before seeding (Codex code review)
    seeds: names.filter((n) => n.startsWith("seeds/")).flatMap((n) => parsed.get(n) as NonNullable<CorpusSources["seeds"]>),
  };
  return { sources, manifest: (parsed.get("demo.json") as DemoManifest | undefined) ?? null, revision: revisionOf(files) };
}

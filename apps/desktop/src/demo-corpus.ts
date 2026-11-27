import type { DemoMailbox } from "@terno/backend";
import { demoCorpusDataset } from "@terno/mock-data";
import { readCorpusSources } from "@terno/mock-data/corpus-node";

/** Plan 292: the variable `dev.mjs --demo` and `--demo-ai` set to the written demo mailbox's folder. */
export const DEMO_CORPUS_ENV = "TERNO_DEMO_CORPUS";

/**
 * The written demo mailbox's folder, out of main's environment before anything is spawned, so no child inherits it.
 * Only with the demo mailbox in an unpackaged build (revision 1): a packaged app seeds the generated mailbox whatever
 * its environment says.
 */
export function takeDemoCorpus(env: Record<string, string | undefined>, demo: boolean, packaged: boolean): string | null {
  const dir = env[DEMO_CORPUS_ENV];
  delete env[DEMO_CORPUS_ENV];
  return demo && !packaged && dir ? dir : null;
}

/** Reads the corpus (as data, once, when an empty demo profile is seeded) and builds the mailbox `seedDemo` takes. */
export function readDemoCorpus(dir: string): DemoMailbox {
  const { sources, manifest } = readCorpusSources(dir);
  if (!manifest) throw new Error(`${dir} has no demo.json: the corpus isn't complete`);
  return { dataset: demoCorpusDataset(sources), rule: manifest.rule, learningSender: manifest.learningSender };
}

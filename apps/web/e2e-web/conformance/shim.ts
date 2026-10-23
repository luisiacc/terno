/**
 * Just enough of vitest's API to run the repo's conformance suites inside a
 * dedicated worker (where OPFS sync access handles exist and vitest can't
 * run): describe/it (+ .each, .runIf, .skip), the four hooks, and vitest's
 * own `expect` (aliased in, unchanged). Tests run sequentially in
 * declaration order; hooks nest like vitest's.
 */
import { expect } from "vitest-expect";

export { expect };

type Fn = () => unknown;
interface Test {
  name: string;
  fn: Fn;
  skip: boolean;
}
interface Suite {
  name: string;
  skip: boolean;
  items: (Test | Suite)[];
  beforeAll: Fn[];
  afterAll: Fn[];
  beforeEach: Fn[];
  afterEach: Fn[];
}

const suite = (name: string, skip = false): Suite => ({ name, skip, items: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] });
const root = suite("");
let current = root;

function collect(name: string, fn: Fn, skip: boolean): void {
  const s = suite(name, skip || current.skip);
  current.items.push(s);
  const parent = current;
  current = s;
  try {
    fn();
  } finally {
    current = parent;
  }
}

export const describe = Object.assign((name: string, fn: Fn) => collect(name, fn, false), {
  skip: (name: string, fn: Fn) => collect(name, fn, true),
  runIf: (condition: unknown) => (name: string, fn: Fn) => collect(name, fn, !condition),
  skipIf: (condition: unknown) => (name: string, fn: Fn) => collect(name, fn, !!condition),
});

function add(name: string, fn: Fn, skip: boolean): void {
  current.items.push({ name, fn, skip: skip || current.skip });
}

const format = (template: string, args: unknown[]) => {
  let i = 0;
  return template.replace(/%[sdij]/g, () => String(args[i++]));
};

export const it = Object.assign((name: string, fn: Fn, _timeout?: number) => add(name, fn, false), {
  skip: (name: string, fn: Fn) => add(name, fn, true),
  runIf: (condition: unknown) => (name: string, fn: Fn) => add(name, fn, !condition),
  skipIf: (condition: unknown) => (name: string, fn: Fn) => add(name, fn, !!condition),
  each:
    <T,>(cases: readonly T[]) =>
    (name: string, fn: (...args: never[]) => unknown) => {
      for (const c of cases) {
        const args = Array.isArray(c) ? c : [c];
        add(format(name, args), () => (fn as (...a: unknown[]) => unknown)(...args), false);
      }
    },
});
export const test = it;

export const beforeAll = (fn: Fn) => void current.beforeAll.push(fn);
export const afterAll = (fn: Fn) => void current.afterAll.push(fn);
export const beforeEach = (fn: Fn) => void current.beforeEach.push(fn);
export const afterEach = (fn: Fn) => void current.afterEach.push(fn);

export interface TestResult {
  name: string;
  state: "pass" | "fail" | "skip";
  ms: number;
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? `${e.message}\n${(e.stack ?? "").split("\n").slice(1, 6).join("\n")}` : String(e));

/** Runs everything collected so far, reporting each test as it finishes. */
export async function run(onResult: (r: TestResult) => void): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const report = (r: TestResult) => (results.push(r), onResult(r));
  const tests = (s: Suite): Test[] => s.items.flatMap((i) => ("items" in i ? tests(i) : [i]));
  const visit = async (s: Suite, path: string[], each: { before: Fn[]; after: Fn[] }) => {
    const live = tests(s).some((t) => !t.skip);
    const chain = { before: [...each.before, ...s.beforeEach], after: [...s.afterEach, ...each.after] };
    let setupError: unknown = null;
    if (live)
      for (const h of s.beforeAll)
        try {
          await h();
        } catch (e) {
          setupError = e;
          break;
        }
    for (const item of s.items) {
      if ("items" in item) {
        if (setupError) for (const t of tests(item)) report({ name: [...path, item.name, t.name].join(" > "), state: "fail", ms: 0, error: `beforeAll: ${message(setupError)}` });
        else await visit(item, [...path, item.name], chain);
        continue;
      }
      const name = [...path, item.name].join(" > ");
      if (item.skip) {
        report({ name, state: "skip", ms: 0 });
        continue;
      }
      if (setupError) {
        report({ name, state: "fail", ms: 0, error: `beforeAll: ${message(setupError)}` });
        continue;
      }
      const started = performance.now();
      let error: unknown = null;
      try {
        for (const h of chain.before) await h();
        await item.fn();
      } catch (e) {
        error = e;
      }
      for (const h of chain.after)
        try {
          await h();
        } catch (e) {
          error ??= e;
        }
      report({ name, state: error ? "fail" : "pass", ms: Math.round(performance.now() - started), error: error ? message(error) : undefined });
    }
    if (live) for (const h of s.afterAll) await Promise.resolve(h()).catch((e) => report({ name: [...path, "afterAll"].join(" > "), state: "fail", ms: 0, error: message(e) }));
  };
  await visit(root, [], { before: [], after: [] });
  return results;
}

import { setTimeout as nativeTimeout, clearTimeout as clearNativeTimeout } from "node:timers";
type FixtureOutcome = { ok: true } | { ok: false; error: unknown };
type FixtureTask = { label: string; work: () => Promise<unknown>; terminalKnown?: () => boolean };
export type ExpectedTerminal = { label: string; consumed: boolean };
export function fixtureCleanup() {
  const releases: (() => void)[] = [], joins: { label: string; result: Promise<FixtureOutcome> }[] = [];
  const terminals: FixtureTask[] = [], dependents: FixtureTask[] = [], independent: FixtureTask[] = [];
  const removals: (() => void)[] = [], errors: unknown[] = [], expected: ExpectedTerminal[] = [];
  const retained: unknown[] = [];
  let serial = 0, finishing = false, watchdog: ReturnType<typeof nativeTimeout> | undefined;
  const observe = (work: Promise<unknown>): Promise<FixtureOutcome> => work.then<FixtureOutcome, FixtureOutcome>(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
  const releaseAll = () => { for (const release of releases.splice(0)) { try { release(); } catch (error) { errors.push(error); } } };
  const arm = () => { if (!finishing) watchdog ??= nativeTimeout(() => { errors.push(new Error("Fixture native release watchdog")); releaseAll(); }, 8000); };
  const register = (queue: FixtureTask[], label: string, work: () => Promise<unknown>, terminalKnown?: () => boolean) => {
    if (retained.length) throw new Error("Fixture owner retained after uncertain teardown");
    arm(); queue.push({ label, work, terminalKnown });
  };
  const bounded = async (label: string, result: Promise<FixtureOutcome>, deadline: number): Promise<FixtureOutcome> => {
    let timer: ReturnType<typeof nativeTimeout> | undefined;
    const timeout = new Promise<FixtureOutcome>((resolve) => {
      timer = nativeTimeout(() => resolve({ ok: false, error: new Error(`Fixture terminal uncertain: ${label}`) }), Math.max(0, Math.min(1500, deadline - performance.now())));
    });
    try { return await Promise.race([result, timeout]); }
    finally { if (timer) clearNativeTimeout(timer); }
  };
  const run = (task: FixtureTask) => observe(Promise.resolve().then(task.work));
  const api = {
    assertAvailable() { if (retained.length) throw new Error("Fixture owner retained after uncertain teardown"); },
    // Legacy first-seven registrations form a dependent chain, in their original LIFO order.
    push(work: () => Promise<void>) { register(dependents, `dependent-${++serial}`, work); },
    independent(label: string, work: () => Promise<unknown>) { register(independent, label, work); },
    remove(work: () => void) { removals.push(work); },
    fault(error: unknown) { errors.push(error); },
    release(work: () => void) { arm(); releases.push(work); },
    watch<T>(label: string, work: Promise<T>): Promise<T> { arm(); joins.push({ label, result: observe(work) }); return work; },
    expectTerminal(label: string): ExpectedTerminal {
      if (expected.some((entry) => entry.label === label)) throw new Error(`Duplicate expected terminal label: ${label}`);
      const entry = { label, consumed: false }; expected.push(entry); return entry;
    },
    gate(label: string, gate: { close(): Promise<void>; resources(): { writer: boolean } }, failure?: ExpectedTerminal) {
      if (failure && failure.label !== label) throw new Error("Expected terminal label does not match registration");
      register(terminals, label, async () => {
        const result = await observe(gate.close());
        // Classification is outside the rejection handler, and requires the predeclared label,
        // exact fixed close error, and actual absence of a physical writer.
        if (failure && !result.ok && result.error instanceof Error && result.error.name === "Error" && result.error.message === "Private cooldown persistence remains unconfirmed" && !gate.resources().writer) {
          if (failure.consumed) throw new Error(`Repeated expected terminal failure: ${failure.label}`);
          failure.consumed = true; return;
        }
        if (!result.ok) throw result.error;
      }, () => !gate.resources().writer);
    },
    async finish() {
      finishing = true;
      const deadline = performance.now() + 5000, terminalDeadline = deadline - 1500;
      if (watchdog) clearNativeTimeout(watchdog);
      watchdog = undefined;
      releaseAll();
      let certain = true;
      const owned: unknown[] = [];
      try {
        // Observe every join/close. A timeout reports uncertainty and never settles its work.
        for (const join of joins.splice(0)) {
          owned.push(join);
          const result = await bounded(join.label, join.result, terminalDeadline);
          if (!result.ok) { certain = false; errors.push(result.error); retained.push(join); }
        }
        const running = terminals.splice(0).reverse().map((task) => ({ ...task, result: run(task) }));
        owned.push(...running);
        for (const task of running) {
          const result = await bounded(task.label, task.result, terminalDeadline);
          if (!result.ok) { certain = false; errors.push(result.error); if (!task.terminalKnown?.()) retained.push(task); }
        }
        for (const task of dependents.splice(0).reverse()) {
          owned.push(task);
          if (!certain) { retained.push(task); errors.push(new Error(`Dependent teardown retained: ${task.label}`)); continue; }
          const result = await bounded(task.label, run(task), terminalDeadline);
          if (!result.ok) { certain = false; errors.push(result.error); retained.push(task); }
        }
      } catch (error) {
        certain = false; errors.push(error);
        retained.push(...owned, ...joins.splice(0), ...terminals.splice(0), ...dependents.splice(0));
      } finally {
        // All independent resource closes start, including on an unexpected cleanup/helper error.
        const resources = independent.splice(0).reverse().map((task) => ({ label: task.label, result: run(task) }));
        for (const task of resources) {
          try {
            const result = await bounded(task.label, task.result, deadline);
            if (!result.ok) { certain = false; errors.push(result.error); retained.push(task); }
          } catch (error) { certain = false; errors.push(error); retained.push(task); }
        }
        if (watchdog) clearNativeTimeout(watchdog);
        watchdog = undefined;
      }
      for (const failure of expected.splice(0)) if (!failure.consumed) errors.push(new Error(`Expected terminal failure not consumed: ${failure.label}`));
      if (certain) for (const remove of removals.splice(0)) { try { remove(); } catch (error) { errors.push(error); } }
      else { retained.push(...removals.splice(0)); }
      releaseAll();
      const failures = errors.splice(0);
      if (retained.length && !failures.length) failures.push(new Error("Fixture owner remains retained after uncertain teardown"));
      if (watchdog) clearNativeTimeout(watchdog);
      watchdog = undefined; finishing = false;
      // Vitest keeps the test-body error and this afterEach error; neither is caught here.
      if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
    },
  };
  return api;
}

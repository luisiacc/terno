import { RpcError } from "@terno/core/rpc";
import { UncertainWriteError } from "@terno/idb/uncertainty";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserBodyUpgrades } from "./body-upgrade";
import { classifyUpgradeFailure } from "./body-upgrade-failure";
import { uncertainStoreFailure } from "./storage-error";

/** The upgrade worker answering as it does after its open is refused. */
function stubWorker(answer: (request: { type: string }) => object) {
  class StubWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(request: { type: string }) { queueMicrotask(() => this.onmessage?.({ data: answer(request) } as MessageEvent)); }
    terminate() {}
  }
  vi.stubGlobal("Worker", StubWorker);
}

afterEach(() => { vi.unstubAllGlobals(); });

it("the worker names only fixed classifications of a refused open", () => {
  expect(classifyUpgradeFailure(new UncertainWriteError())).toBe("uncertain-dirty");
  expect(classifyUpgradeFailure(new UncertainWriteError("unreadable"))).toBe("uncertain-unreadable");
  expect(classifyUpgradeFailure(new Error("Database schema is newer than this app (IndexedDB v26). Update Terno."))).toBe("newer");
  expect(classifyUpgradeFailure(new Error("synthetic private body text"))).toBeUndefined();
});

it("an uncertain mailbox refused by the upgrade worker still reaches the uncertain gate, not a generic one", async () => {
  stubWorker(() => ({ type: "retired", ok: false, cancelled: false, failure: "uncertain-dirty" }));
  const error = await new BrowserBodyUpgrades().run("idb", "synthetic").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UncertainWriteError);
  expect(uncertainStoreFailure(error)).toMatchObject({ type: "fatal", code: "UNCERTAIN_STORE" });
});

it("a newer mailbox keeps the message the startup gate reads as SCHEMA_NEWER; an unclassified fault stays UNAVAILABLE", async () => {
  stubWorker(() => ({ type: "retired", ok: false, cancelled: false, failure: "newer" }));
  const newer = await new BrowserBodyUpgrades().run("idb", "synthetic").catch((e: unknown) => e);
  expect((newer as Error).message).toMatch(/newer than this app/);
  stubWorker(() => ({ type: "retired", ok: false, cancelled: false }));
  const fault = await new BrowserBodyUpgrades().run("idb", "synthetic").catch((e: unknown) => e);
  expect(fault).toBeInstanceOf(RpcError);
  expect(fault).toMatchObject({ code: "UNAVAILABLE" });
});

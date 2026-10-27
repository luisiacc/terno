import { afterEach, expect, it, vi } from "vitest";
import { demoRegistry, type IncomingProcessor } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";
import * as incoming from "./incoming-worker";

const backends: Backend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});
const fake = (): IncomingProcessor => ({ run: vi.fn(), whenIdle: vi.fn(async () => {}), close: vi.fn(async () => {}) });
function backend(processor?: IncomingProcessor) {
  const owned = new Backend({ dbPath: ":memory:", version: "synthetic", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, instantSearch: false, iconTransport: null, incomingProcessor: processor });
  backends.push(owned);
  return owned;
}

it("creates the default lazy processor and closes it through Backend ownership", async () => {
  const processor = fake();
  const factory = vi.spyOn(incoming, "createNodeIncomingProcessor").mockReturnValue(processor);
  const owned = backend();
  expect(factory).toHaveBeenCalledOnce();
  expect(processor.run).not.toHaveBeenCalled();
  await owned.stop();
  backends.splice(backends.indexOf(owned), 1);
  expect(processor.close).toHaveBeenCalledOnce();
});

it("preserves an explicitly provided processor without constructing another default", async () => {
  const supplied = fake();
  const factory = vi.spyOn(incoming, "createNodeIncomingProcessor");
  const owned = backend(supplied);
  expect(factory).not.toHaveBeenCalled();
  await owned.stop();
  backends.splice(backends.indexOf(owned), 1);
  expect(supplied.close).toHaveBeenCalledOnce();
});

import { UncertainWriteError } from "@terno/idb/uncertainty";
import { L } from "@terno/i18n";

export function uncertainStoreFailure(error: unknown) {
  return error instanceof UncertainWriteError ? { type: "fatal", code: "UNCERTAIN_STORE", message: L("web.gate.uncertain.body") } as const : null;
}

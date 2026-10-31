import init from "@sqlite.org/sqlite-wasm";
import { wasmSqliteDriver, type WasmImages } from "../wasm-driver";

export async function captureRepairWasm(images: WasmImages) {
  return wasmSqliteDriver(await init(), { images });
}

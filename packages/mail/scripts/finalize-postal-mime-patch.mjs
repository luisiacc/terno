import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodedMappings, encodedMap, TraceMap } from "@jridgewell/trace-mapping";

// Run after tsc emits ESM/CJS, with a pristine `pnpm patch --ignore-existing` package.
const [edited, published] = process.argv.slice(2);
if (!edited || !published) throw new Error("Usage: finalize-postal-mime-patch.mjs <edited-package> <published-package>");
for (const directory of [edited, published]) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.name !== "postal-mime" || manifest.version !== "4.1.3") throw new Error("Expected postal-mime4.1.3");
}
const read = (directory, file) => readFileSync(join(directory, file), "utf8");
const cjsEntry = "dist/cjs/postal-mime.js";
const marker = "//# sourceMappingURL=postal-mime.js.map";
const anchor = "exports.default = PostalMime;\n";
const publishedCode = read(published, cjsEntry).split(marker)[0];
const wrapper = publishedCode.slice(publishedCode.lastIndexOf(anchor) + anchor.length);
if (!wrapper.startsWith("for (const key of Object.keys(exports))") || !wrapper.endsWith("module.exports = exports.default;\n")) throw new Error("Unexpected published CJS wrapper");
const emitted = read(edited, cjsEntry);
if (!emitted.endsWith(marker)) throw new Error("Unexpected CJS source-map comment");
let code = emitted.slice(0, -marker.length);
if (code.endsWith(wrapper)) code = code.slice(0, -wrapper.length);
if (!code.endsWith(anchor)) throw new Error("Unexpected emitted CJS export");
writeFileSync(join(edited, cjsEntry), code + wrapper + marker);

// The package's namespace/export= declaration is custom build output, not tsc's ESM layout.
const esmDeclaration = read(edited, "dist/esm/postal-mime.d.ts");
if (esmDeclaration !== read(published, "dist/esm/postal-mime.d.ts")) throw new Error("Unexpected public declaration change");
const cjsDeclaration = read(published, "dist/cjs/postal-mime.d.ts");
writeFileSync(join(edited, "dist/cjs/postal-mime.d.ts"), cjsDeclaration);
const esm = esmDeclaration.split("\n");
const cjs = cjsDeclaration.split("\n");
const esmClass = esm.findIndex((line) => line.startsWith("export default class PostalMime"));
const cjsClass = cjs.findIndex((line) => line.startsWith("declare class PostalMime"));
const esmEnd = esm.indexOf("}", esmClass);
const cjsEnd = cjs.indexOf("}", cjsClass);
const esmImport = esm.findIndex((line) => line.startsWith("import type "));
const cjsImport = cjs.findIndex((line) => line.startsWith("import type "));
if (Math.min(esmClass, cjsClass, esmEnd, cjsEnd, esmImport, cjsImport) < 0 || esm[esmImport] !== cjs[cjsImport] || esm.slice(esmClass + 1, esmEnd + 1).join("\n") !== cjs.slice(cjsClass + 1, cjsEnd + 1).join("\n")) throw new Error("Unexpected custom CJS declaration layout");
const map = new TraceMap(JSON.parse(read(edited, "dist/esm/postal-mime.d.ts.map")));
const decoded = decodedMappings(map);
const mappings = Array.from({ length: cjsEnd + 1 }, () => []);
mappings[cjsImport] = decoded[esmImport].map((segment) => [...segment]);
for (let line = esmClass; line <= esmEnd; line++) {
  const nameColumn = esm[esmClass].indexOf("PostalMime");
  const shift = cjs[cjsClass].indexOf("PostalMime") - nameColumn;
  mappings[cjsClass + line - esmClass] = decoded[line]
    .filter((segment) => line !== esmClass || segment[0] === 0 || segment[0] >= nameColumn)
    .map((segment) => [segment[0] + (line === esmClass && segment[0] > 0 ? shift : 0), ...segment.slice(1)]);
}
const result = encodedMap(new TraceMap({ version: 3, file: "postal-mime.d.ts", sourceRoot: map.sourceRoot, sources: map.sources, names: map.names, mappings }));
writeFileSync(join(edited, "dist/cjs/postal-mime.d.ts.map"), JSON.stringify(result));

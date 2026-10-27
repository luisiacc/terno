import { build } from "esbuild";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backend = fileURLToPath(new URL("../", import.meta.url));
export async function buildIncomingWorker(outDir = join(backend, "dist")) {
  await mkdir(outDir, { recursive: true });
  const temporary = await mkdtemp(join(outDir, ".incoming-worker-"));
  try {
    const output = join(temporary, "incoming.worker.cjs");
    const result = await build({
      entryPoints: [join(backend, "src/incoming.worker.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["node:*"],
      minify: true,
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
    });
    for (const file of Object.values(result.metafile.outputs)) {
      if (file.imports.some((entry) => entry.external && !entry.path.startsWith("node:"))) throw new Error("Incoming worker has an external dependency");
    }
    const destination = join(outDir, "incoming.worker.cjs");
    await rename(output, destination);
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildIncomingWorker(process.argv[2] ? resolve(process.argv[2]) : undefined);
}

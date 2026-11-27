// Plan 293: build.mjs bundles and runs this to write the bridge's offline manifest (never shipped).
import { offlineManifest } from "./offline";

void offlineManifest(process.argv[2] ?? "0.1.0").then((m) => process.stdout.write(JSON.stringify(m)));

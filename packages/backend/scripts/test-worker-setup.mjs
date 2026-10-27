import { buildIncomingWorker } from "./build-incoming-worker.mjs";

export default async function setup() {
  await buildIncomingWorker();
}

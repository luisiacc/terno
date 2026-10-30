import { rmSync } from "node:fs";
import { dirname } from "node:path";
import setup from "./global-setup";
import { TEMPLATE_ENV } from "./constants";

/** Reuse the search fixtures, then remove only this run's synthetic template. */
export default async function searchCoverageSetup() {
  await setup();
  const template = process.env[TEMPLATE_ENV]!;
  return () => rmSync(dirname(template), { recursive: true, force: true });
}

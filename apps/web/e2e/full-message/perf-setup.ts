import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import globalSetup from "../global-setup";
import { TEMPLATE_ENV } from "../constants";

export default async function setup() {
  await globalSetup();
  const path = process.env[TEMPLATE_ENV];
  if (!path) throw new Error("Missing owned synthetic template");
  writeFileSync("/tmp/terno-w11-full-61640/perf-template.json", JSON.stringify({ path }));
  return () => rmSync(dirname(path), { recursive: true });
}

/**
 * A test build's own world, baked in by scripts/build.mjs (TERNO_TEST_BUILD):
 * its update feed, profile and app name. Squirrel relaunches an updated app
 * without our environment, so a test can't steer it by env; and a release
 * is built without this, so nothing in the environment can point it at
 * another feed or profile through here. Imported first by main.ts, before
 * profile.ts reads its variables.
 */
import type { TestBuild } from "./updates/policy";

declare const __TERNO_TEST_BUILD__: TestBuild | undefined;

export const TEST_BUILD: TestBuild | undefined = typeof __TERNO_TEST_BUILD__ === "undefined" ? undefined : __TERNO_TEST_BUILD__;

/** The profile a test build always uses, whatever the environment says (a no-op in a release). */
export function applyTestBuild(env: NodeJS.ProcessEnv, build: TestBuild | undefined = TEST_BUILD): void {
  if (!build) return;
  env.TERNO_USER_DATA = build.userData;
  env.TERNO_TEST_APP_DATA = build.appData;
  env.TERNO_TEST_APP_NAME = build.appName;
}

applyTestBuild(process.env);

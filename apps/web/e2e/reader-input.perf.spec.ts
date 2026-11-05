/** Plan 37: the check for remote content stays linear on hostile input. In the perf stage (plan 139): it reads a clock, alone. */
import { expect, test } from "./fixtures";

test("56 KB of <image in a message: a parse, not the old regex's rescan at each (about 140 ms)", async ({ app: page }) => {
  const ms = await page.evaluate(() => {
    const hostile = "<image ".repeat(40_000);
    const t0 = performance.now();
    (window as unknown as { __terno: { hasRemoteContent(h: string): boolean } }).__terno.hasRemoteContent(hostile);
    return performance.now() - t0;
  });
  expect(ms).toBeLessThan(100);
});

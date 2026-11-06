import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MIGRATIONS } from "./migrations";

/**
 * Shipped migrations are frozen (plan 139): installs have already run them, so an edit reaches only new ones and two
 * installs would disagree. It's also why `migrations.perf` needn't time each old step at 50k: its SQL can't regress
 * unless someone edits it. A new migration adds a line; an edit of one already here is a new migration instead.
 */
const SHIPPED: [number, string][] = [
  [1, "cc178b24d9e8e9de"],
  [2, "9c8ebf85660f8a02"],
  [3, "705997a72e7eda9e"],
  [4, "1f35f036cb9ba5fd"],
  [5, "28b0297d28894b56"],
  [6, "ae22f786e293b3cb"],
  [7, "b9c0dcdd1b4e43b2"],
  [8, "7765f2afbf296b96"],
  [9, "c8c810ec603d24a1"],
  [10, "05989c4f9111b442"],
  [11, "e964659f415b8b71"],
  [12, "67df024aa72a8c86"],
  [13, "b73fe01144334947"],
  [14, "9690841247594466"],
  [15, "088679fa2ca19c87"],
  [16, "208d641ec3dec2ae"],
  [17, "c0d054c627de15b0"],
  [18, "e0a7d5c0d58c87e2"],
  [19, "3b484c8227ca0afc"],
  [20, "1a9e86f3569c93a0"],
  [21, "fb15e89c0419d3ad"],
  [22, "88e9ff7ccf796930"],
  [23, "e26d29aaed5fc64c"],
  [24, "2aacdac670f0c83d"],
  [25, "e28b443e7a2e0c14"],
  [26, "99df53180cbd359b"],
  [27, "efbf12622b3b43b0"],
  [28, "d0a8a56efa5127de"],
  [29, "7a5c189f2cfcc102"],
  [30, "c5d02051d9d866a9"],
  [31, "9d82e0cd10f9c10b"],
  [32, "2ec1be38ac30dc90"],
  [33, "2530e1f29cc1fcc0"],
  [34, "10e0a03fbdba2aa4"],
  [35, "2a77bc2c8d875e8a"],
  [36, "f856390a88423565"],
  [37, "3350c5ab7d2bade1"],
  [38, "91cc763e86f63f6e"],
  [39, "2e25a60fa6782738"],
  [40, "7335e47993aa0300"],
  [41, "c48803fc4de8ad68"],
  [42, "034083622921bc16"],
  [43, "453a7ab436efcd02"],
  [44, "5f3df96f536b4931"],
  [45, "14e29aa88c3a69e9"],
  [46, "2c3753fd530e5b52"],
  [47, "cd921d22a10d3ce0"],
  [48, "075cfa9cdba42353"],
  [49, "09f4822d6df94d15"],
  [50, "f45fb84bb651acc6"],
  [51, "e2dc13d5a9c66c0a"],
  [52, "bb36ae362e83d939"],
  [53, "7e473f5b2e06222e"],
  [54, "37ddb876fee2c6b6"],
];

it("a shipped migration's SQL never changes, and a new one is added here", () => {
  expect(MIGRATIONS.map((m): [number, string] => [m.version, createHash("sha256").update(m.sql).digest("hex").slice(0, 16)])).toEqual(SHIPPED);
});

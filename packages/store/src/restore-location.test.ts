import { expect, it } from "vitest";
import { restoreLocationOps, sameLocation } from "./flag-intents";

const destinations = [
  { inInbox: true, isTrash: false, isSpam: false },
  { inInbox: false, isTrash: false, isSpam: false },
  { inInbox: false, isTrash: true, isSpam: false },
  { inInbox: false, isTrash: false, isSpam: true },
];
for (let mask = 0; mask < 8; mask++) it.each(destinations)(`restores canonical destination from location mask ${mask}: %j`, (to) => {
  const from = { inInbox: !!(mask & 1), isTrash: !!(mask & 2), isSpam: !!(mask & 4) };
  const ops = restoreLocationOps(from, to);
  expect(ops.length).toBeLessThanOrEqual(2);
  if (sameLocation(from, to)) expect(ops).toEqual([]);
  const actual = { ...from };
  for (const op of ops) {
    if (op === "moveToInbox") Object.assign(actual, { inInbox: true, isTrash: false, isSpam: false });
    if (op === "archive") actual.inInbox = false;
    if (op === "trash") Object.assign(actual, { inInbox: false, isTrash: true });
    if (op === "spam") Object.assign(actual, { inInbox: false, isSpam: true });
  }
  expect(actual).toEqual(to);
});

const mixedDestinations = [
  { inInbox: false, isTrash: true, isSpam: true },
];
for (let mask = 0; mask < 8; mask++) it.each(mixedDestinations)(`restores supported mixed destination from location mask ${mask}: %j`, (to) => {
  const from = { inInbox: !!(mask & 1), isTrash: !!(mask & 2), isSpam: !!(mask & 4) };
  const actual = { ...from }, ops = restoreLocationOps(from, to);
  expect(ops.length).toBeLessThanOrEqual(2);
  if (sameLocation(from, to)) expect(ops).toEqual([]);
  for (const op of ops) {
    if (op === "moveToInbox") Object.assign(actual, { inInbox: true, isTrash: false, isSpam: false });
    if (op === "archive") actual.inInbox = false;
    if (op === "trash") Object.assign(actual, { inInbox: false, isTrash: true });
    if (op === "spam") Object.assign(actual, { inInbox: false, isSpam: true });
    if (op === "notSpam") Object.assign(actual, { inInbox: true, isSpam: false });
  }
  expect(actual).toEqual(to);
});

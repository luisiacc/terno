import { expect, it } from "vitest";
import { operationFlagFields, restoreLocationOps, restoreOneFolderOps, sameLocation } from "./flag-intents";
import { applyLocationOpOne, LEAVE_FOLDER, MOVE_TO_FOLDER, RETURN_TO } from "./folder-move";

// Plan 259 (exact undo): where a one-folder (Outlook) message's undo takes it, from each place to each place
const places = {
  folder: { inInbox: false, isTrash: false, isSpam: false, folder: "F" },
  other: { inInbox: false, isTrash: false, isSpam: false, folder: "G" },
  archive: { inInbox: false, isTrash: false, isSpam: false, folder: null },
  inbox: { inInbox: true, isTrash: false, isSpam: false, folder: null },
  trash: { inInbox: false, isTrash: true, isSpam: false, folder: null },
  junk: { inInbox: false, isTrash: false, isSpam: true, folder: null },
};
const received = { isSent: false, isDraft: false };
for (const [from, now] of Object.entries(places)) {
  it(`one-folder undo from ${from}: a user folder is one filing back, Archive one returnTo, the Inbox, Trash and Junk their own ops`, () => {
    const same = (to: keyof typeof places) => from === to;
    expect(restoreOneFolderOps(now, places.folder, received)).toEqual(same("folder") ? [] : [{ kind: MOVE_TO_FOLDER, folder: "F" }]);
    expect(restoreOneFolderOps(now, places.archive, received)).toEqual(same("archive") ? [] : [{ kind: RETURN_TO, role: "archive" }]);
    expect(restoreOneFolderOps(now, places.inbox, received)).toEqual(restoreLocationOps(now, places.inbox).map((kind) => ({ kind })));
    expect(restoreOneFolderOps(now, places.trash, received)).toEqual(restoreLocationOps(now, places.trash).map((kind) => ({ kind })));
    expect(restoreOneFolderOps(now, places.junk, received)).toEqual(restoreLocationOps(now, places.junk).map((kind) => ({ kind })));
  });
}

it("one-folder undo: your own message goes back to Sent Items and a draft to Drafts; a folder's flags elsewhere don't count", () => {
  expect(restoreOneFolderOps(places.trash, places.archive, { isSent: true, isDraft: false })).toEqual([{ kind: RETURN_TO, role: "sent" }]);
  expect(restoreOneFolderOps(places.inbox, places.archive, { isSent: true, isDraft: true })).toEqual([{ kind: RETURN_TO, role: "drafts" }]);
  // a stored folder under Inbox flags (a move on its way) is the Inbox: nothing to do
  expect(restoreOneFolderOps({ ...places.inbox, folder: "F" }, places.inbox, received)).toEqual([]);
  // a snapshot's folder with Trash flags is Trash
  expect(restoreOneFolderOps(places.inbox, { ...places.trash, folder: "F" }, received)).toEqual([{ kind: "trash" }]);
});

it("returnTo owns the three location flags; a location op on its way replays as Graph moves it", () => {
  expect(operationFlagFields(RETURN_TO)).toEqual(["inInbox", "isTrash", "isSpam"]);
  for (const kind of ["trash", "spam", "moveToInbox", RETURN_TO]) expect(applyLocationOpOne("F", kind, {})).toBeNull();
  for (const kind of ["archive", "notSpam", "markRead"]) expect(applyLocationOpOne("F", kind, {})).toBe("F");
  expect(applyLocationOpOne(null, MOVE_TO_FOLDER, { folder: "G", from: null, keepInbox: false })).toBe("G");
  expect(applyLocationOpOne("G", LEAVE_FOLDER, { folder: "G", back: null, toInbox: true, stays: false })).toBeNull();
});

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

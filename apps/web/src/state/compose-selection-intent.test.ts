import { expect, it } from "vitest";
import { getSelectionWriteRevision, markSelectionIntent, subscribeComposeSelectionIntent } from "./app";

it("retires only the captured conversion registration on each explicit selection intent", () => {
  const initial = getSelectionWriteRevision(), calls: string[] = [];
  let stopNew = () => {};
  const stopOld = subscribeComposeSelectionIntent(() => {
    calls.push(`old:${getSelectionWriteRevision()}`);
    stopNew = subscribeComposeSelectionIntent(() => calls.push(`new:${getSelectionWriteRevision()}`));
  });
  try {
    markSelectionIntent();
    expect(calls).toEqual([`old:${initial + 1}`]);
    stopOld();
    markSelectionIntent();
    expect(calls).toEqual([`old:${initial + 1}`, `new:${initial + 2}`]);
    stopNew();
    markSelectionIntent();
    expect(calls).toHaveLength(2);
  } finally { stopOld(); stopNew(); }
});

import { DIGEST_ROW_ID } from "@terno/core";
import { useEffect } from "react";
import { act } from "~/lib/actions";
import { onReadSetByHand } from "~/lib/read-by-hand";
import { getApp } from "~/state/app";
import { useList } from "~/state/list";
import { useThreads } from "~/state/threads";

/** Long enough that holding j passes rows by unread. */
export const READ_DWELL = 450;

/** The row or, off the list, the open conversation's thread. */
function rowOf(id: number) {
  const st = useList.getState();
  return st.items[st.index.get(id) ?? -1] ?? useThreads.getState().details.get(id)?.thread;
}

const hidden = (): boolean => typeof document !== "undefined" && document.hidden;

/**
 * Plan 225: the one rule for reading by looking. A conversation on screen in the reader for READ_DWELL is read, however
 * it came to be open (a click, j/k, the first load, a mailbox switch, a search's top hit, Archive going on, Undo). Only
 * the reader starts a showing, once the conversation itself is drawn (not its skeleton), and ends it when it stops
 * drawing it: no path that opens a thread has anything to remember.
 *
 * The dwell counts only while the window can be seen (a launch in the background reads nothing). What it reads is the
 * conversation as it is when the dwell ends (a cached copy refreshed meanwhile included). One read per showing, and none
 * once the user sets its read state by hand: a Mark as unread inside it, before the dwell or after, stays until it's
 * shown again.
 */
export function showThread(id: number): () => void {
  // the digest's page isn't a thread (plan 145): it reads its own newsletters
  if (id === DIGEST_ROW_ID) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    clearTimeout(timer);
    offHand();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", arm);
  };
  const offHand = onReadSetByHand((ids) => {
    if (ids.includes(id)) end();
  });
  const read = () => {
    end();
    if (rowOf(id)?.unread && getApp().selectedId === id) void act("markRead", [id], { quiet: true });
  };
  // hidden, the dwell waits; seen again, it starts over
  function arm() {
    clearTimeout(timer);
    timer = hidden() ? undefined : setTimeout(read, READ_DWELL);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", arm);
  arm();
  return end;
}

/** The reader's showing of `id`, from when its conversation is drawn (`drawn`) until it isn't. */
export function useReadOnShow(id: number | null, drawn: boolean): void {
  useEffect(() => (id !== null && drawn ? showThread(id) : undefined), [id, drawn]);
}

import { getApp } from "~/state/app";
import { loadThread, threadCached } from "~/state/threads";
import { listLayout, readerShown } from "./page";

/**
 * Plan 221: conversations warmed ahead of a click, so one opens from the cache. Callers say what is likely next (the rows
 * on screen, the keyboard's next ones); this decides whether, when and how much. A read of this Mac's store only: no
 * network, no read state, and a mail's remote pictures still load only once it's opened (the owner's choice).
 */

/** a fling or a held scroll warms nothing until the list rests this long */
const SETTLE_MS = 150;
/** a tall window of compact rows (32 px) shows about 45 */
const SCREEN_MAX = 48;
/** the keyboard looks two ahead */
const NEXT_MAX = 2;
const IN_FLIGHT_MAX = 2;

const work = {
  /** the rows on screen, in the order they're warmed; empty until the list rests */
  screen: [] as number[],
  /** the rows on screen as last reported, while the list hasn't rested */
  reported: [] as number[],
  /** the list is scrolling: nothing on screen starts */
  scrolling: false,
  /** the keyboard's next conversations: first, and without waiting */
  next: [] as number[],
  timer: null as ReturnType<typeof setTimeout> | null,
  running: 0,
  /** a hidden window waits for this listener (only while something waits) */
  waking: false,
};

/**
 * The rows on screen, top first (the digest's row, 0, isn't a thread), and whether the list is scrolling. Replaces the
 * last set; warmed once the list has rested a moment.
 */
export function warmOnScreen(ids: readonly number[], scrolling = false): void {
  // from the open row outward, the likeliest next click being beside it (top first when it isn't on screen); trimmed after.
  // The open one is the reader's to load
  const open = getApp().selectedId;
  const at = ids.indexOf(open ?? -1);
  const near = at < 0 ? ids : ids.map((id, i) => ({ id, far: Math.abs(i - at) })).sort((a, b) => a.far - b.far).map((r) => r.id);
  work.reported = near.filter((id) => id !== 0 && id !== open).slice(0, SCREEN_MAX);
  work.screen = [];
  work.scrolling = scrolling;
  if (work.timer) clearTimeout(work.timer);
  work.timer = work.reported.length && !scrolling ? setTimeout(settle, SETTLE_MS) : null;
  if (!work.reported.length) quiet();
}

/** The keyboard's next conversations, nearest first: warmed now, ahead of what's on screen. Replaces the last ones. */
export function warmNext(ids: readonly number[]): void {
  work.next = ids.filter((id) => id !== 0).slice(0, NEXT_MAX);
  if (work.next.length) pump();
  else quiet();
}

/** Nothing on screen, nothing next (the list went): nothing waits. */
export function warmNothing(): void {
  warmOnScreen([]);
  warmNext([]);
}

function settle(): void {
  work.timer = null;
  work.screen = work.reported;
  pump();
}

/** with nothing left to warm, a hidden window has nothing to wake for */
function quiet(): void {
  if (work.next.length || work.screen.length || work.reported.length || !work.waking) return;
  document.removeEventListener("visibilitychange", wake);
  work.waking = false;
}

function take(): number | undefined {
  const open = getApp().selectedId;
  // R12 (plan 24): no conversation work while List's list page is up; there, the rows on screen never warm either, as
  // opening one covers them
  if (!readerShown()) return undefined;
  for (const queue of listLayout() || work.scrolling ? [work.next] : [work.next, work.screen]) {
    while (queue.length) {
      const id = queue.shift()!;
      if (id !== open && !threadCached(id)) return id;
    }
  }
  return undefined;
}

function pump(): void {
  if (document.visibilityState !== "visible") {
    if ((work.next.length || work.screen.length || work.reported.length) && !work.waking) {
      work.waking = true;
      document.addEventListener("visibilitychange", wake);
    }
    return;
  }
  while (work.running < IN_FLIGHT_MAX) {
    const id = take();
    if (id === undefined) return;
    work.running++;
    void loadThread(id).finally(() => {
      work.running--;
      pump();
    });
  }
}

function wake(): void {
  if (document.visibilityState !== "visible") return;
  document.removeEventListener("visibilitychange", wake);
  work.waking = false;
  pump();
}

/** Tests only: nothing waits, nothing is listened for. */
export function resetWarmForTests(): void {
  if (work.timer) clearTimeout(work.timer);
  if (work.waking) document.removeEventListener("visibilitychange", wake);
  Object.assign(work, { screen: [], reported: [], scrolling: false, next: [], timer: null, running: 0, waking: false });
}

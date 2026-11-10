/**
 * Plan 170: the whoosh once a message goes. One element, made on the first
 * send (no work until then), rewound for each one after; never awaited, and a
 * play that fails (no output device, autoplay refused) is let go: the sound is
 * a nicety, never part of the send.
 */
import sentUrl from "~/assets/sent.wav";
import { getApp } from "~/state/app";

const player: { el: HTMLAudioElement | null } = { el: null };

const on = () => getApp().settings?.sendSound === true && typeof Audio !== "undefined";

/**
 * In the click or key that sends, before anything is awaited: WebKit lets an
 * element play later only if it was touched in a gesture (Codex critique #2),
 * and the file is read while the send is prepared.
 */
export function primeSendSound(): void {
  if (!on() || player.el) return;
  try {
    player.el = new Audio(sentUrl);
    player.el.preload = "auto";
    player.el.load();
  } catch {
    // (nothing to say about a sound that can't play; the send goes on)
  }
}

export function playSendSound(): void {
  if (!on()) return;
  try {
    const el = (player.el ??= new Audio(sentUrl));
    el.currentTime = 0;
    void el.play()?.catch(() => {});
  } catch {
    // (as above)
  }
}

/** tests: the next play makes its element again */
export function resetSendSound(): void {
  player.el = null;
}

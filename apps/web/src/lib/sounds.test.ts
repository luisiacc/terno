/** Plan 170: the send sound plays with its setting, from one element, and never throws. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings } from "@terno/core/rpc";
import { setApp } from "~/state/app";
import { playSendSound, primeSendSound, resetSendSound } from "./sounds";

const made: { src: string; currentTime: number; play: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> }[] = [];
let play: () => unknown = () => Promise.resolve();

beforeEach(() => {
  made.length = 0;
  play = () => Promise.resolve();
  resetSendSound();
  vi.stubGlobal("Audio", vi.fn(function (this: (typeof made)[number], src: string) {
    Object.assign(this, { src, currentTime: 0, play: vi.fn(() => play()), load: vi.fn() });
    made.push(this);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); setApp({ settings: null }); });

const withSetting = (sendSound: boolean) => setApp({ settings: { sendSound } as AppSettings });

it("plays the bundled whoosh with the setting on, from one element rewound each time", () => {
  withSetting(true);
  playSendSound();
  expect(made).toHaveLength(1);
  expect(made[0]!.src).toMatch(/sent\.wav/);
  expect(made[0]!.play).toHaveBeenCalledOnce();
  made[0]!.currentTime = 0.2;
  playSendSound();
  expect(made).toHaveLength(1);
  expect(made[0]!.currentTime).toBe(0);
  expect(made[0]!.play).toHaveBeenCalledTimes(2);
});

it("stays quiet with the setting off, or before settings load, and makes nothing", () => {
  withSetting(false);
  playSendSound();
  setApp({ settings: null });
  playSendSound();
  expect(made).toHaveLength(0);
});

it("a play that fails, refused or throwing, is let go", async () => {
  withSetting(true);
  play = () => Promise.reject(new Error("NotAllowedError"));
  expect(() => playSendSound()).not.toThrow();
  play = () => { throw new Error("no device"); };
  expect(() => playSendSound()).not.toThrow();
  // jsdom's play() returns nothing
  play = () => undefined;
  expect(() => playSendSound()).not.toThrow();
  await Promise.resolve();
});

it("primed in the gesture (Codex critique #2): the element is made and loaded then, and the play uses it", () => {
  withSetting(false);
  primeSendSound();
  expect(made).toHaveLength(0);
  withSetting(true);
  primeSendSound();
  primeSendSound();
  expect(made).toHaveLength(1);
  expect(made[0]!.load).toHaveBeenCalledOnce();
  expect(made[0]!.play).not.toHaveBeenCalled();
  playSendSound();
  expect(made).toHaveLength(1);
  expect(made[0]!.play).toHaveBeenCalledOnce();
});

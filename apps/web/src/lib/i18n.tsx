/**
 * The renderer's language: picked before the first frame from the setting
 * this window saw last, then kept in step with `settings.language` (and the
 * system's languages while it's "system"). Changing it re-renders the app
 * once under a new key (see LocaleRoot): the React Compiler memoizes
 * components on their inputs, and t() is a plain function, so only a
 * remount reaches every string and date.
 */
import { isLanguageSetting, isLocalized, LOCALES, getLocale, loadLocale, resolveLocale, rich, setLocale, translate, type LanguageSetting, type LocaleId, type RichKey, type RichParams } from "@terno/i18n";
import { Fragment, useLayoutEffect, type ReactNode } from "react";
import { create } from "zustand";

export const LANGUAGE_KEY = "terno:language";

/** Bumped after each locale change: LocaleRoot keys the app on it. */
export const useLocaleEpoch = create<{ epoch: number; locale: LocaleId }>(() => ({ epoch: 0, locale: getLocale() }));

function systemLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function cachedSetting(): LanguageSetting {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return isLanguageSetting(v) ? v : "system";
  } catch {
    return "system";
  }
}

let setting: LanguageSetting = "system";
/** Settings → Language saves in flight (commitLanguage). */
let committing = 0;
let seq = 0;

function publish(id: LocaleId): void {
  document.documentElement.lang = LOCALES[id].tag;
}

/**
 * Before the first render: the last setting this window saw, resolved
 * against today's system languages. English needs nothing; another locale
 * loads its chunk. A failure leaves English (the app renders either way).
 */
export async function initLocale(): Promise<void> {
  setting = cachedSetting();
  const id = resolveLocale(setting, systemLanguages());
  try {
    if (id !== getLocale()) await loadLocale(id);
  } catch (error) {
    console.warn("[i18n] could not load", id, error);
  }
  publish(getLocale());
  useLocaleEpoch.setState({ locale: getLocale() });
}

/** What the scroll and focus were before a switch, put back after the remount. */
let restore: { scroll: Map<string, number>; focus: string | null } | null = null;

/**
 * Applies a language setting: cached for the next start, loaded, then
 * published at once. A newer call wins over a slower older one.
 * `focusAfter` is the id of the control that made the change (focus goes
 * back to it after the remount).
 */
export async function applyLanguage(next: LanguageSetting, focusAfter?: string): Promise<void> {
  setting = next;
  try {
    localStorage.setItem(LANGUAGE_KEY, next);
  } catch {}
  const mine = ++seq;
  const id = resolveLocale(next, systemLanguages());
  if (id === getLocale()) return;
  try {
    const catalog = await LOCALES[id].load();
    if (mine !== seq) return;
    const scroll = new Map<string, number>();
    for (const el of document.querySelectorAll<HTMLElement>("[data-keep-scroll]")) scroll.set(el.dataset.keepScroll!, el.scrollTop);
    restore = { scroll, focus: focusAfter ?? null };
    // set before the re-mount: a dialog picks its initial focus in its own effects, before LocaleRoot's
    focusAfterSwitch = focusAfter ?? null;
    setLocale(id, catalog);
    publish(id);
    document.documentElement.classList.add("motion-paused");
    useLocaleEpoch.setState((s) => ({ epoch: s.epoch + 1, locale: id }));
  } catch (error) {
    console.warn("[i18n] could not switch to", id, error);
  }
}

/**
 * A choice made in Settings: the app switches at once, the setting is saved,
 * and a failed save says so and goes back to `was`, unless a newer choice
 * was made in the meantime.
 */
export async function commitLanguage(next: LanguageSetting, was: LanguageSetting, save: () => Promise<void>, onError: (error: unknown) => void, focusAfter?: string): Promise<void> {
  const switched = applyLanguage(next, focusAfter);
  committing++;
  try {
    await save();
  } catch (error) {
    onError(error);
    await switched;
    if (setting === next) await applyLanguage(was);
    return;
  } finally {
    committing--;
  }
  await switched;
}

/** Keeps the language in step with the settings and, while it's "system", with the system. */
export function installLanguageFollower(subscribe: (listener: (language: LanguageSetting | undefined) => void) => () => void): () => void {
  const off = subscribe((language) => {
    // while this window's own choices are being saved, the answers in between are older than the choice
    if (language && language !== setting && committing === 0) void applyLanguage(language);
  });
  const onSystem = () => setting === "system" && void applyLanguage("system");
  window.addEventListener("languagechange", onSystem);
  return () => {
    off();
    window.removeEventListener("languagechange", onSystem);
  };
}

let focusAfterSwitch: string | null = null;

/** A dialog's initial focus: none while a switch re-mounts the app (restoreAfterSwitch puts it back on the control that made it), else the default. */
export function switchFocus(): boolean {
  return focusAfterSwitch === null;
}

/**
 * After a switch's re-mount: the scroll offsets and focus come back (the
 * list's rows and the reader's messages mount over a frame or two, so the
 * offsets are put back as they appear), and motion resumes two frames
 * later. Outside the component: the React Compiler would read `restore`
 * after it is cleared.
 */
function restoreAfterSwitch(): void {
  const r = restore;
  if (!r) return;
  restore = null;
  const put = () => {
    for (const [key, top] of r.scroll) {
      const el = document.querySelector<HTMLElement>(`[data-keep-scroll="${key}"]`);
      if (el && el.scrollTop !== top) el.scrollTop = top;
    }
  };
  // focus goes back to the control that made the change, never away from where the user moved it since
  // (a modal's focus trap moves focus to its first control when the old tree takes the focused
  // element away: that isn't the user; a click or Tab is)
  let moved = false;
  const onPointer = () => (moved = true);
  const onKey = (e: KeyboardEvent) => (moved ||= e.key === "Tab" || e.key === "Escape" || e.key === "F6");
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  const focus = () => {
    if (!r.focus || moved || document.activeElement?.id === r.focus) return;
    document.getElementById(r.focus)?.focus({ preventScroll: true });
  };
  put();
  focus();
  let frames = 0;
  const start = performance.now();
  const tick = () => {
    put();
    focus();
    if (++frames === 2) document.documentElement.classList.remove("motion-paused");
    // a dialog can take focus well after it mounts (its open transition): keep watching for half a second
    if (performance.now() - start < 500) requestAnimationFrame(tick);
    else {
      focusAfterSwitch = null;
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    }
  };
  requestAnimationFrame(tick);
}

/** The app, re-mounted once per locale change. */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const epoch = useLocaleEpoch((s) => s.epoch);
  useLayoutEffect(() => restoreAfterSwitch(), [epoch]);
  return <Fragment key={epoch}>{children}</Fragment>;
}

/**
 * Text the backend sent with its catalog reference (an op's error, an
 * account's last error, a test warning): the reference in the active
 * language when this build knows it, else the text as sent.
 */
export function localized<T extends string | null | undefined>(text: T, ref: { key: string; params?: Readonly<Record<string, string | number>> } | null | undefined): T | string {
  if (!ref || !isLocalized(ref)) return text;
  return translate({ ...ref, message: text ?? undefined });
}

/** rich() for React: tag renderers return elements, keyed here. */
export function richT<K extends RichKey>(key: K, params: RichParams<K, ReactNode>): ReactNode {
  return rich<K, ReactNode>(key, params).map((part, i) => (typeof part === "string" ? part : <Fragment key={i}>{part}</Fragment>));
}

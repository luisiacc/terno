/**
 * Plan 192: focus the app moves itself (an emptied list handing it on, a page closing), told apart from focus the user
 * moves (Tab, a click): a control that holds while the user is on it reads `quietFocus.moving` in its focus handler.
 */
export const quietFocus = { moving: false };

export function focusQuietly(el: HTMLElement | null | undefined, options: FocusOptions = { preventScroll: true }): void {
  if (!el) return;
  quietFocus.moving = true;
  try {
    el.focus(options);
  } finally {
    quietFocus.moving = false;
  }
}

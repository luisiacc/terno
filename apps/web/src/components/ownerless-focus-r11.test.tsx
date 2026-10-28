// @vitest-environment jsdom
import { act } from 'react';
import { flushSync } from 'react-dom';
import { expect, it, vi } from 'vitest';
import { setup } from './draft-presentation-r1-harness';

it.each([false, true])('cleans an ownerless move when publication throws (consumed=%s)', async (consume) => {
  const h = await setup('split', true), { focusDraft } = await import('~/lib/compose'); let hit = false;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
    const off = h.app.useApp.subscribe((state, previous) => {
      if (hit || !state.draftFocus || state.draftFocus === previous.draftFocus) return;
      hit = true;
      if (consume) { flushSync(() => {}); expect(h.app.getApp().draftFocus).toBeNull(); }
      throw new Error('publication failed');
    });
    try { await act(async () => { expect(() => focusDraft(h.key, 'body')).toThrow('publication failed'); }); } finally { off(); }
    expect(hit).toBe(true); expect(h.app.getApp().draftFocus).toBeNull();
    for (let i = 0; i < 14; i++) await h.flush();
    expect(document.activeElement).toBe(h.other);
    await act(async () => { focusDraft(h.key, 'body'); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await h.cleanup(); }
});

it('cancels its exact pending move and listener when its slot unmounts', async () => {
  const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
    await act(async () => { focusDraft(h.key, 'body'); });
    const listeners = add.mock.calls.filter(([type, , capture]) => type === 'focusin' && capture === true).map(([, listener]) => listener);
    expect(listeners.length).toBeGreaterThan(0);
    await act(async () => { h.root.unmount(); await Promise.resolve(); });
    expect(listeners.some((listener) => remove.mock.calls.some(([type, removed, capture]) => type === 'focusin' && removed === listener && capture === true))).toBe(true);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    for (let i = 0; i < 14; i++) await h.flush();
    expect(document.activeElement).toBe(h.other);
  } finally { add.mockRestore(); remove.mockRestore(); await h.cleanup(); }
});

it('expires an ownerless request when no DraftSlot consumes it', async () => {
  const h = await setup('split', false), { focusDraft } = await import('~/lib/compose');
  try {
    await act(async () => { h.other.focus(); focusDraft(h.key, 'body'); });
    expect(h.app.getApp().draftFocus?.key).toBe(h.key);
    for (let i = 0; i < 14; i++) await h.flush();
    expect(h.app.getApp().draftFocus).toBeNull(); expect(document.activeElement).toBe(h.other);
  } finally { await h.cleanup(); }
});

it('cancels an unconsumed ownerless request on pagehide without blocking a later request', async () => {
  const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
    await act(async () => { focusDraft(h.key, 'body'); expect(h.app.getApp().draftFocus?.key).toBe(h.key); window.dispatchEvent(new Event('pagehide')); });
    expect(h.app.getApp().draftFocus).toBeNull();
    for (let i = 0; i < 14; i++) await h.flush();
    expect(document.activeElement).toBe(h.other);
    await act(async () => { focusDraft(h.key, 'body'); });
    for (let i = 0; i < 4; i++) await h.flush();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await h.cleanup(); }
});

it('does not focus an inert slot after the bounded move expires', async () => {
  const h = await setup('split', true), { focusDraft } = await import('~/lib/compose');
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open' }); h.other.focus(); });
    h.host.setAttribute('inert', '');
    await act(async () => { focusDraft(h.key, 'body'); });
    for (let i = 0; i < 14; i++) await h.flush();
    expect(h.app.getApp().draftFocus).toBeNull(); expect(document.activeElement).toBe(h.other);
  } finally { h.host.removeAttribute('inert'); await h.cleanup(); }
});

it.each((['split', 'list'] as const).flatMap((layout) => (['before-effect', 'after-effect', 'ordinary'] as const).map((scenario) => [layout, scenario] as const)))('%s ownerless later focus %s', async (layout, scenario) => {
  const h = await setup(layout, true), { focusDraft } = await import('~/lib/compose');
  const later = document.createElement('button'); document.body.append(later); let captured: { key: string; seq: number } | null = null;
  try {
    await act(async () => { h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open', toText: 'synthetic@example.test' }); h.other.focus(); });
    const initial = h.drafts.useDrafts.getState().drafts[h.key]!;
    await act(async () => {
      focusDraft(h.key, 'body');
      const request = h.app.getApp().draftFocus;
      if (scenario === 'before-effect') { expect(request).not.toBeNull(); expect(request!.key).toBe(h.key); captured = { key: request!.key, seq: request!.seq }; later.focus(); expect(document.activeElement).toBe(later); }
    });
    if (scenario === 'before-effect') expect(captured).not.toBeNull();
    if (scenario === 'after-effect') { expect(h.app.getApp().draftFocus).toBeNull(); await act(async () => { later.focus(); }); }
    expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(initial.bodyText);
    expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(initial.toText);
    for (let i = 0; i < 4; i++) await h.flush();
    if (scenario === 'ordinary') expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
    else expect(document.activeElement).toBe(later);
  } finally { later.remove(); await h.cleanup(); }
});

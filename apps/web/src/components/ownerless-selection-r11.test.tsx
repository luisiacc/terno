// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import type { ThreadSummary } from '@terno/core';
import { setup } from './draft-presentation-r1-harness';

it.each((['split', 'list'] as const).flatMap((layout) => (['key', 'passive', 'ordinary', 'successor', 'after-effect'] as const).map((scenario) => [layout, scenario] as const)))('%s ownerless selection intent %s', async (layout, scenario) => {
  const h = await setup(layout, true), { focusDraft } = await import('~/lib/compose'), { useList } = await import('~/state/list');
  const list = useList.getState(); let hit = false, requestKey: string | undefined;
  try {
    const row = { id: 7, lastDate: 1, categoryIds: [], unread: false } as unknown as ThreadSummary;
    await act(async () => { useList.setState({ items: [row], index: new Map([[7, 0]]), nextCursor: null }); h.drafts.editDraft(h.key, { threadId: 7, showSourceContext: false, uiState: 'open', toText: 'synthetic@example.test' }); });
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="action-reply"]'); expect(button).not.toBeNull();
    await act(async () => { button!.focus(); }); expect(document.activeElement).toBe(button);
    const initial = h.drafts.useDrafts.getState().drafts[h.key]!, revision = h.app.getSelectionWriteRevision();
    const keydown = () => button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
    const off = h.app.useApp.subscribe((state, previous) => {
      if (!hit && state.draftFocus && state.draftFocus !== previous.draftFocus) {
        hit = true; requestKey = state.draftFocus.key;
        if (scenario === 'key' || scenario === 'successor') keydown();
        if (scenario === 'passive') h.app.setListAutoSelection(7);
        if (scenario === 'successor') focusDraft(h.key, 'to');
      }
    });
    try { await act(async () => { focusDraft(h.key, 'body'); }); } finally { off(); }
    expect(hit).toBe(true); expect(requestKey).toBe(h.key); expect(h.app.getApp().selectedId).toBe(7);
    if (scenario === 'after-effect') { expect(h.app.getApp().draftFocus).toBeNull(); await act(async () => { keydown(); }); }
    expect(h.app.getSelectionWriteRevision()).toBe(revision + (['key', 'successor', 'after-effect'].includes(scenario) ? 1 : 0));
    expect(h.drafts.useDrafts.getState().drafts[h.key]!.bodyText).toBe(initial.bodyText);
    expect(h.drafts.useDrafts.getState().drafts[h.key]!.toText).toBe(initial.toText);
    for (let i = 0; i < 4; i++) await h.flush();
    if (scenario === 'key' || scenario === 'after-effect') expect(document.activeElement).toBe(button);
    else if (scenario === 'successor') expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
    else expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await act(async () => { useList.setState(list, true); }); await h.cleanup(); }
});


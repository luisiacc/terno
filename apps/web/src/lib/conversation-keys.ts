/** What the keyboard asks of the open conversation (N, P, ⇧E, the palette): set while one with several messages shows. */
export const conversationKeys: { current: { step: (delta: 1 | -1) => void; toggleAll: () => void; allOpen: () => boolean } | null } = { current: null };

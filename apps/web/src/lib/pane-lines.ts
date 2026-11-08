/**
 * Plan 160: the lines every pane shares, written once (the tokens are in globals.css). No component repeats the
 * arithmetic: `pane-lines.test.ts` refuses a copy elsewhere.
 */

/** The reading column: the reader's toolbar and conversation, New message, the selection panel, a toast over the reader. One width in Split and List. */
export const READING_COLUMN = "mx-auto w-full max-w-(--reader-max) px-(--reader-pad-x) @max-[420px]:px-4";

/** A reader-pane title: the subject, New message, the selection's count. Narrow (a container query), a step smaller. */
export const PANE_TITLE = "type-reader-subject @max-[560px]:text-xl @max-[560px]:tracking-[-0.01em]";

/** Under the reader's toolbar row, the gap to its title's line */
export const PANE_TITLE_GAP = "pt-(--pane-title-gap) @max-[560px]:pt-0";

/** A pane with no toolbar (New message, the selection) starts its title where the reader's is: the row, the gap, and (Atelier) the chips' line */
export const PANE_TITLE_TOP = "pt-[calc(var(--pane-bar)+var(--pane-title-gap)+var(--pane-title-lead))] @max-[560px]:pt-[calc(var(--pane-bar)+var(--pane-title-lead))]";

/** Under a pane title, before what it heads (the reader's header block's gap) */
export const PANE_TITLE_AFTER = "mb-3 @max-[560px]:mb-2";

/** The text measure: a message's plain text, a draft's text, the text it quotes */
export const READ_MEASURE = "max-w-(--read-max)";

/** --read-max, for a mail frame's own document (it can't read the app's tokens, and its text is in the body type) */
export const READ_MAX_CSS = "35em";

// The screen sets a round can rate (plans 158 and 161), frozen with the round (round.json): which screens a report
// scores, which shots the capture writes, and which brief the raters read. Each shot is written -light and -dark.

const EVERYDAY_SHOTS = [
  "01-split-inbox", "02-split-conversation", "03-split-draft-open", "04-split-draft-collapsed", "05-new-message-empty", "06-new-message-filled",
  "07-search-results", "08-command-palette", "09-multi-select", "10-row-menu", "11-list-inbox", "12-list-conversation", "13-list-draft-open",
  "14-archive-undo", "15-filtered-unread", "16-small-split-inbox", "17-small-draft-open",
];

/** ◆ in plan 161's table: also shot in a 1100x700 window, as `<name>-small`. */
export const AI_SMALL = ["a01-summary", "a02-draft-prompt", "a03-draft-written", "a04-ask-answer", "a05-actions-preview"];
const AI_SHOTS = ["a01-summary", "a02-draft-prompt", "a03-draft-written", "a04-ask-answer", "a05-actions-preview", "a06-actions-undo", "a07-today", "a08-today-digest", "a09-followup", "a10-reply-ready", "a11-filter-ai", "a12-writing-style"];

export const SETS = {
  everyday: {
    brief: "brief.md",
    screens: ["split_inbox", "conversation", "reply_draft", "new_message", "list_layout_inbox", "search", "command_palette", "multi_select", "row_menu"],
    shots: EVERYDAY_SHOTS,
  },
  ai: {
    brief: "brief-ai.md",
    screens: ["summary", "ai_draft", "ask", "actions", "today", "followups_replies", "ai_settings"],
    shots: AI_SHOTS.flatMap((s) => (AI_SMALL.includes(s) ? [s, `${s}-small`] : [s])),
  },
};

/** Every file a set's capture writes for one style. */
export const shotFiles = (set) => SETS[set].shots.flatMap((s) => [`${s}-light.png`, `${s}-dark.png`]);

/** `--screens <set>` from argv; the everyday set when it's left out. */
export function screensFlag(argv) {
  const i = argv.indexOf("--screens");
  const set = i < 0 ? "everyday" : argv[i + 1];
  if (!SETS[set]) throw new Error(`--screens takes ${Object.keys(SETS).join(" or ")}, not ${set}`);
  return set;
}

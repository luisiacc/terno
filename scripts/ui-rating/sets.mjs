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

/** `--ai real|stub` from argv (plan 161): the AI set runs Pro's real models unless told to use the local stand-in. */
export function aiFlag(argv) {
  const i = argv.indexOf("--ai");
  const ai = i < 0 ? "real" : argv[i + 1];
  if (ai !== "real" && ai !== "stub") throw new Error(`--ai takes real or stub, not ${ai}`);
  return ai;
}

const REAL_WORDS = "The app is running real AI models, so their words can differ from one run to the next: rate how the app presents, explains and lets you act on what the model wrote. The words themselves are in scope only where the app could have shown them better.";
const STUB_WORDS = "The AI here is a local stand-in model that gives the same answers every time: rate how the app presents, explains and lets you act on what the model wrote, not the model's words themselves.";

/**
 * The AI brief for the round's models (plan 161, Codex review): brief-ai.md speaks of real models; a stub round says
 * the stand-in, and its raters launch with `ai: "stub"`, so a hands-on try never reaches a provider or spends.
 */
export function briefFor(text, ai) {
  if (ai !== "stub") return text;
  if (!text.includes(REAL_WORDS)) throw new Error("brief-ai.md's paragraph on the models changed: briefFor's words must follow it");
  return text.replace(REAL_WORDS, STUB_WORDS).replace("with AI on the same real models as the screenshots (`ai: true`):", "with AI on the local stand-in (`ai: true`; nothing leaves the machine):").replaceAll("ai: true", 'ai: "stub"');
}

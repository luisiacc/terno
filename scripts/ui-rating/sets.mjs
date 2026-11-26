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

/**
 * Plan 214: What matters on its own, on Pro's real models (its rows are what the app's readers found in the demo mailbox):
 * the feed at rest, a row hovered (Done and Later), a row open beside the reader (the feed narrowed, the next row hovered),
 * further down (the automated mail, Coming up open), the feed in a 1100x700 window, and Earlier.
 */
const WM_SHOTS = ["w01-feed", "w02-feed-hover", "w03-feed-reader", "w04-feed-further", "w05-feed-small", "w06-feed-earlier"];

/**
 * Plan 282: Put away on its own, from a seed (apps/backend-dev/src/put-away-seed.ts): the Inbox with its one line, the
 * view, a rule's box (a colleague your own rule caught), Terno's own filing's box, and that in a 1100x700 window.
 */
const PA_SHOTS = ["p01-inbox-line", "p02-put-away", "p03-box-rule", "p04-box-terno", "p05-small"];

/**
 * Plan 281: People on its own: the list beside a person's page, an item hovered (Done and Later), the search, Everyone,
 * a person's card in a conversation's people chip, the page in List layout, and a 1100x700 window. AI on the local
 * stand-in: People's lines are What matters' own and the follow-ups' (the stand-in's), and nothing leaves the machine.
 */
const PEOPLE_SHOTS = ["p01-people", "p02-person-hover", "p03-people-search", "p04-people-everyone", "p05-person-card", "p06-people-list-layout", "p07-people-small"];

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
  whatmatters: {
    brief: "brief-wm.md",
    screens: ["what_matters"],
    shots: WM_SHOTS,
  },
  putaway: {
    brief: "brief-pa.md",
    screens: ["put_away"],
    shots: PA_SHOTS,
  },
  people: {
    brief: "brief-people.md",
    screens: ["people_list", "person_page", "person_card"],
    shots: PEOPLE_SHOTS,
  },
};

/** Whether a set's app runs AI (the AI set and What matters): its capture and its raters launch with `ai`. */
export const usesAi = (set) => set === "ai" || set === "whatmatters" || set === "people";

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
  // (plan 281: a brief written for the stand-in already says so)
  if (ai !== "stub" || text.includes(STUB_WORDS)) return text;
  if (!text.includes(REAL_WORDS)) throw new Error("brief-ai.md's paragraph on the models changed: briefFor's words must follow it");
  return text.replace(REAL_WORDS, STUB_WORDS).replace("with AI on the same real models as the screenshots (`ai: true`):", "with AI on the local stand-in (`ai: true`; nothing leaves the machine):").replaceAll("ai: true", 'ai: "stub"');
}

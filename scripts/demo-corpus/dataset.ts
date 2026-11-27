// Plan 292: builds the whole demo mailbox as the app would seed it and prints what came out.
//   pnpm --filter @terno/backend-dev exec tsx ../../scripts/demo-corpus/dataset.ts [--brand <id>] [--thread <seed id>] [--sample N]
// Counts per account and kind, the demo day's newsletters, his sent mail in the last 30 days; --brand and --thread print
// filled messages (bodies as the reader would get them).
import { demoCorpusDataset } from "../../packages/mock-data/src/demo-corpus/load.ts";
import { DEMO_CORPUS_DIR, readCorpusSources } from "../../packages/mock-data/src/demo-corpus/node.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const { sources, revision } = readCorpusSources(DEMO_CORPUS_DIR);
const started = performance.now();
const data = demoCorpusDataset(sources);
const ms = Math.round(performance.now() - started);
const anchor = Date.parse(sources.world.anchor);
const DAY = 86_400_000;
const count = (f: (m: (typeof data.messages)[number]) => string) => Object.entries(data.messages.reduce<Record<string, number>>((o, m) => ((o[f(m)] = (o[f(m)] ?? 0) + 1), o), {})).map(([k, n]) => `${k} ${n}`).join(", ");

console.log(`corpus ${revision}: ${data.messages.length} messages in ${ms} ms`);
console.log(`by account: ${count((m) => data.accounts[m.accountIndex]!.displayName)}`);
console.log(`by kind: ${count((m) => (m.isSpam ? "spam" : m.bulk ? "bulk" : "written"))}`);
console.log(`by tag: ${count((m) => m.tag)}`);
const sent30 = data.messages.filter((m) => m.isSent && anchor - m.date <= 30 * DAY).length;
const today = data.messages.filter((m) => m.listId && m.bulk && anchor - m.date < DAY && !m.isRead && m.inInbox);
console.log(`his sent in the last 30 days: ${sent30}; unread newsletters in the Inbox on the demo day: ${today.length} (${today.map((m) => m.from.name).join(", ")})`);
console.log(`unread in the Inbox: ${data.messages.filter((m) => !m.isRead && m.inInbox).length}; in the Inbox: ${data.messages.filter((m) => m.inInbox).length}`);

const brand = arg("brand");
const thread = arg("thread");
const n = Number(arg("sample") ?? 3);
const show = (list: typeof data.messages) => {
  for (const m of list) console.log(`\n----- ${new Date(m.date).toISOString()} ${m.from.name} <${m.from.email}> → ${m.to.map((a) => a.email).join(", ")}\n${m.subject}\n\n${m.bodyText}`);
};
if (brand) {
  const b = sources.world.brands.find((x) => x.id === brand);
  const all = data.messages.filter((m) => m.from.email === b?.fromEmail);
  show(all.filter((_, i) => i % Math.max(1, Math.floor(all.length / n)) === 0).slice(0, n));
}
if (thread) show(data.messages.filter((m) => m.providerMsgId.startsWith(`d-${thread}-`)));

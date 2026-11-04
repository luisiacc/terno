import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ComposeInput, ComposeTask } from "@terno/ai";
import { detectWritingLanguage } from "../../packages/core/src/writing/language";
import { realTasks, spendReport } from "./harness";

/** Does the model hold to the language the task names, across combinations of thread, habit and instruction? A few cents. */
const base = (subject: string, inbound: string, examples: string[]): Omit<ComposeInput, "task"> => ({
  sender: { name: "Rodrigo Aldana", address: "rodrigo@aldana.example" },
  signature: null,
  instructions: [],
  voice: [],
  messagesToPerson: examples.map((text, i) => ({ date: `2026-10-0${i + 1}`, subject, text })),
  pastConversations: [],
  thread: inbound ? [{ from: "Claire Dubois", date: "2026-11-03", own: false, text: inbound }] : [],
  subject,
});
const task = (language: string, instruction: string, kind: ComposeTask["kind"] = "reply"): ComposeTask => ({ kind, today: "2026-11-04", timezone: "UTC", recipients: ["Claire Dubois"], instruction, needsSubject: false, language });

const CASES = [
  { name: "English thread, habit in Spanish, instruction in English", want: "es", input: base("Contract", "Hello, could you please confirm that the contract is ready for us to sign this week?", ["Hola Claire, el contrato sigue en revisión. Te aviso en cuanto esté listo."]), task: task("Spanish", "say yes it is ready, she can sign on Thursday") },
  { name: "Spanish thread, English task, instruction in Spanish", want: "en", input: base("Reunión", "Hola, ¿podemos vernos el jueves para revisar el contrato con el equipo?", ["Hi Claire, thanks for the note, I will have a look and get back to you."]), task: task("English", "dile que sí, el jueves a las 10") },
  { name: "French habit, instruction in English", want: "fr", input: base("Devis", "Bonjour, avez-vous reçu notre devis pour les travaux ? Merci de me dire si cela vous convient.", ["Bonjour Claire, merci pour votre message. Je vous réponds dans la semaine."]), task: task("French", "tell her it looks fine and we accept") },
  { name: "German, new message", want: "de", input: base("Termin", "", ["Hallo Claire, danke für die Nachricht. Ich bin nächste Woche im Büro."]), task: task("German", "ask if she can meet on tuesday", "new") },
  { name: "Asked for in the instruction, against the task", want: "en", input: base("Reunión", "Hola, ¿podemos vernos el jueves para revisar el contrato?", ["Hola Claire, gracias, lo vemos."]), task: task("Spanish", "say yes, thursday works, but write it in English") },
];

describe("holding to the language", () => {
  it("across combinations", async () => {
    const tasks = realTasks({ provider: "anthropic", model: "claude-sonnet-5-5" }, "language");
    const rows = [];
    for (const c of CASES) {
      const result = await tasks.compose({ ...c.input, task: c.task }, { effort: "low", onDelta: () => {} });
      rows.push({ name: c.name, want: c.want, got: detectWritingLanguage(result.text), text: result.text });
    }
    writeFileSync("/tmp/terno-ai/language-real.json", JSON.stringify({ rows, spend: spendReport() }, null, 1));
    for (const r of rows) expect(r.got, r.name).toBe(r.want);
  });
});

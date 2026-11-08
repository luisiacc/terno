import { startModelStub, type ModelStub } from "../../../scripts/ui-rating/model-stub.mjs";

/**
 * A stand-in for Ollama on 127.0.0.1: model list, model details and an OpenAI-compatible chat endpoint that answers
 * every AI task. One source with the UI rating's stub (plan 161): the answers live in scripts/ui-rating/model-stub.mjs.
 */
export function startOllamaStub(options: { chatDelayMs?: number; chatHeld?: Promise<void>; summaryFails?: () => number | null } = {}): Promise<ModelStub> {
  return startModelStub(options);
}

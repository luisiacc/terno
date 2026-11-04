import { L } from "@terno/i18n";
import { AiError, type Completion, type CompletionRequest, type ModelTransport, type Usage } from "./types";

/** The longest answer Terno keeps from a stream: a runaway model can't fill memory. */
export const MAX_STREAM_CHARS = 200_000;

export interface StreamResult {
  text: string;
  stop: Completion["stop"];
  usage?: Usage;
}

/**
 * A completion as a stream, with one contract for every provider: `onDelta`
 * sees the text as it comes, and the promise resolves exactly once with the
 * terminal outcome or rejects with a typed AiError. A transport without
 * streaming yields one delta. `idleMs` bounds silence between events, and
 * `firstMs` the wait for the first one (a local model may be loading).
 */
export async function streamCompletion(
  transport: ModelTransport,
  req: CompletionRequest,
  onDelta: (text: string) => void,
  timing: { idleMs: number; firstMs: number },
): Promise<StreamResult> {
  if (!transport.stream) {
    const completion = await transport.complete(req);
    if (completion.text) onDelta(completion.text);
    return completion;
  }
  const watchdog = new AbortController();
  const signal = AbortSignal.any([req.signal, watchdog.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => watchdog.abort(), ms);
    (timer as { unref?: () => void }).unref?.();
  };
  arm(timing.firstMs);
  let text = "";
  let stop: Completion["stop"] | null = null;
  let usage: Usage | undefined;
  try {
    for await (const event of transport.stream({ ...req, signal })) {
      arm(timing.idleMs);
      if (event.type === "delta") {
        if (text.length + event.text.length > MAX_STREAM_CHARS) {
          stop = "length";
          break;
        }
        text += event.text;
        onDelta(event.text);
      } else {
        stop = event.stop;
        usage = event.usage;
      }
    }
  } catch (error) {
    if (req.signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
    if (watchdog.signal.aborted) throw new AiError(L("errors.ai.tooSlow"), "timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (req.signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
  if (watchdog.signal.aborted) throw new AiError(L("errors.ai.tooSlow"), "timeout");
  // a stream that ended with no terminal event was cut off
  if (stop === null) throw new AiError(L("errors.ai.emptyAnswer", { provider: "AI" }), "unavailable");
  return { text, stop, ...(usage ? { usage } : {}) };
}

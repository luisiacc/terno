import { MAX_INCOMING_MIME_BYTES } from "@terno/core";
import { IncomingProcessingError, incomingInputTransfers, type IncomingGmailMetadata, type IncomingProcessingInput, type IncomingProcessingLimits, type IncomingProcessingResult, type IncomingWorkerReply, type IncomingWorkerRequest } from "./incoming-processing";
import { parseRaw, parseRawHeaders, type IncomingMimeLimits, type ParsedMessage } from "./mime";

const MIME_LIMITS: IncomingMimeLimits = {
  maxPartCount: 1000,
  maxNestingDepth: 64,
  maxHeadersSize: 512 * 1024,
  maxRfc822NestingDepth: 10,
  maxForwardedAddresses: 2048,
};
const HEADER_BYTES = 65536;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function resource(value: unknown, expectedId: string): { metadata: IncomingGmailMetadata; raw: string } {
  if (!record(value) || value.id !== expectedId || !nonempty(value.threadId) || typeof value.raw !== "string" || !value.raw.length) throw new IncomingProcessingError("malformed-resource");
  if (value.labelIds !== undefined && (!Array.isArray(value.labelIds) || !value.labelIds.every(nonempty))) throw new IncomingProcessingError("malformed-resource");
  if (value.internalDate !== undefined) {
    if (typeof value.internalDate !== "string" || !/^-?\d+$/.test(value.internalDate)) throw new IncomingProcessingError("malformed-resource");
    let start = value.internalDate.startsWith("-") ? 1 : 0;
    while (value.internalDate[start] === "0") start++;
    const digits = value.internalDate.length - start;
    if (digits > 16 || (digits === 16 && value.internalDate.slice(start) > "8640000000000000")) throw new IncomingProcessingError("malformed-resource");
  }
  if (value.sizeEstimate !== undefined && (typeof value.sizeEstimate !== "number" || !Number.isSafeInteger(value.sizeEstimate) || value.sizeEstimate < 0)) throw new IncomingProcessingError("malformed-resource");
  return {
    metadata: {
      id: expectedId,
      threadId: value.threadId,
      ...(value.labelIds === undefined ? {} : { labelIds: value.labelIds as string[] }),
      ...(value.internalDate === undefined ? {} : { internalDate: value.internalDate as string }),
      ...(value.sizeEstimate === undefined ? {} : { sizeEstimate: value.sizeEstimate as number }),
    },
    raw: value.raw,
  };
}

function flatten(input: IncomingProcessingInput): Uint8Array {
  const chunks = input.chunks;
  input.chunks = [];
  if (chunks.length === 1) return chunks[0]!;
  const flat = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { flat.set(chunk, offset); offset += chunk.byteLength; }
  return flat;
}

function decodedSize(raw: string): number {
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const end = raw.length - padding;
  if (!end || end % 4 === 1 || (padding && raw.length % 4 !== 0)) throw new IncomingProcessingError("malformed-base64");
  for (let i = 0; i < end; i++) {
    const code = raw.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 95)) throw new IncomingProcessingError("malformed-base64");
  }
  return Math.floor(end * 3 / 4);
}

function decode(raw: string, size: number): Uint8Array {
  const output = new Uint8Array(size);
  const end = Math.min(raw.length, Math.ceil(size / 3) * 4);
  let offset = 0;
  for (let i = 0; i < end; i += 65536) {
    const binary = atob(raw.slice(i, Math.min(end, i + 65536)).replace(/-/g, "+").replace(/_/g, "/"));
    for (let j = 0; j < binary.length && offset < size; j++) output[offset++] = binary.charCodeAt(j);
  }
  return output;
}

function completeHeader(prefix: Uint8Array): boolean {
  for (let i = 0; i + 1 < prefix.byteLength; i++) {
    if (prefix[i] === 10 && (prefix[i + 1] === 10 || (i + 2 < prefix.byteLength && prefix[i + 1] === 13 && prefix[i + 2] === 10))) return true;
  }
  return false;
}

async function parse(bytes: Uint8Array, oversized: boolean): Promise<ParsedMessage> {
  try {
    if (oversized) {
      const prefix = bytes.subarray(0, HEADER_BYTES);
      if (!completeHeader(prefix)) throw new IncomingProcessingError("envelope-unavailable");
      return await parseRawHeaders(prefix, "size", MIME_LIMITS);
    }
    return await parseRaw(bytes, { limits: MIME_LIMITS });
  } catch (error) {
    if (error instanceof IncomingProcessingError) throw error;
    if (record(error)) {
      switch (error.code) {
        case "EMAXPARTCOUNT": throw new IncomingProcessingError("mime-limit-parts");
        case "EMAXNESTINGDEPTH": throw new IncomingProcessingError("mime-limit-depth");
        case "EMAXHEADERSIZE": throw new IncomingProcessingError("mime-limit-headers");
        case "EMAXFORWARDEDADDRESSES": throw new IncomingProcessingError("mime-limit-addresses");
      }
    }
    throw new IncomingProcessingError("worker-fault");
  }
}

function checkResult(result: IncomingProcessingResult, limits: IncomingProcessingLimits): void {
  for (const value of [limits.maxResultTextCodeUnits, limits.maxResultMetadataCodeUnits]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new IncomingProcessingError("input-limit");
  }
  const message = result.message;
  if (limits.maxResultTextCodeUnits !== undefined && (message.text?.length ?? 0) + (message.html?.length ?? 0) > limits.maxResultTextCodeUnits) throw new IncomingProcessingError("result-limit");
  if (limits.maxResultMetadataCodeUnits === undefined) return;
  let size = 0;
  const charge = (value: string | null | undefined) => {
    size += value?.length ?? 0;
    if (size > limits.maxResultMetadataCodeUnits!) throw new IncomingProcessingError("result-limit");
  };
  for (const value of [message.rfcMessageId, message.inReplyTo, message.subject, message.listId, ...message.references]) charge(value);
  for (const address of [message.from, ...message.replyTo, ...message.to, ...message.cc, ...message.bcc]) { charge(address.name); charge(address.email); }
  for (const part of message.attachments) { charge(part.filename); charge(part.mime); charge(part.contentId); }
  if (result.kind === "gmail") {
    charge(result.metadata.id); charge(result.metadata.threadId); charge(result.metadata.internalDate);
    for (const label of result.metadata.labelIds ?? []) charge(label);
  }
}

/** Consumes worker-owned chunks. No account, transport or store capability enters this module. */
export async function processIncoming(input: IncomingProcessingInput, limits: IncomingProcessingLimits = {}): Promise<IncomingProcessingResult> {
  incomingInputTransfers(input);
  let source = flatten(input);
  let result: IncomingProcessingResult;
  if (input.kind === "mime") {
    result = { kind: "mime", message: await parse(source, source.byteLength > MAX_INCOMING_MIME_BYTES) };
  } else {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)); }
    catch { throw new IncomingProcessingError("malformed-json"); }
    source = new Uint8Array(0);
    const read = resource(value, input.expectedId);
    value = undefined;
    const size = decodedSize(read.raw);
    const oversized = size > MAX_INCOMING_MIME_BYTES;
    const decoded = decode(read.raw, oversized ? Math.min(size, HEADER_BYTES) : size);
    read.raw = "";
    result = { kind: "gmail", metadata: read.metadata, message: await parse(decoded, oversized) };
  }
  checkResult(result, limits);
  return result;
}

export async function runIncomingWorkerRequest(request: IncomingWorkerRequest): Promise<IncomingWorkerReply> {
  try {
    const result = await processIncoming(request.input, request.limits);
    return { type: "result", incarnation: request.incarnation, job: request.job, result };
  } catch (error) {
    return { type: "error", incarnation: request.incarnation, job: request.job, code: error instanceof IncomingProcessingError ? error.code : "worker-fault" };
  }
}

export function incomingResultTransfers(result: IncomingProcessingResult): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const part of result.message.attachments) {
    let bytes = part.bytes;
    if (!bytes) continue;
    if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) part.bytes = bytes = new Uint8Array(bytes);
    buffers.add(bytes.buffer as ArrayBuffer);
  }
  return [...buffers];
}

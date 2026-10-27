import type { AttachmentInfo } from "@terno/core";

export const resources = new Map<string, { ref: AttachmentInfo; chunks: string[] }>();
export const reads: string[] = [];
/** A local asynchronous RPC source; the production reader still validates and decodes every chunk. */
export const client = {
  async call(method: string, p: { accountId: number; assetId: string; index: number }) {
    if (p.accountId !== 7) throw new Error("Unexpected fixture account");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const resource = resources.get(p.assetId);
    if (!resource) throw new Error("Missing fixture asset");
    if (method === "attachments.info") return resource.ref;
    if (method === "attachments.read") { reads.push(p.assetId); return { dataBase64: resource.chunks[p.index] }; }
    throw new Error(`Unexpected fixture call: ${method}`);
  },
};

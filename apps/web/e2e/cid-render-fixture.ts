export { resolveCidHtml } from "../src/lib/cid";
export { resources, reads } from "./cid-rpc-fixture";

/** Literal non-ASCII code points must survive classic-script response decoding. */
export const unicodeSentinel = "café 日本語 ̀ͯ";

import type { JSHandle, Locator } from "@playwright/test";

/** Target live text as previews settle, including layout changes made by drag handlers. */
export async function dragAfter(body: Locator, data: JSHandle<DataTransfer>, text: string, types: ("dragenter" | "dragover" | "drop")[]): Promise<void> {
  await body.evaluate((el, { data, text, types }) => {
    const point = () => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const i = node.data.indexOf(text);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i + text.length - 1);
        range.setEnd(node, i + text.length);
        const r = range.getBoundingClientRect();
        return { clientX: r.right - 1, clientY: r.top + r.height / 2 };
      }
      throw new Error(`no ${text}`);
    };
    for (const type of types) {
      const coords = point();
      el.dispatchEvent(new DragEvent(type, { dataTransfer: data, ...coords, bubbles: true, cancelable: true }));
    }
  }, { data, text, types });
}

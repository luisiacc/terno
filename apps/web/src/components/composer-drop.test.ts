import { describe, expect, it } from "vitest";
import { dragFiles, dropLabel } from "./composer-drop";

const data = (types: string[], items: { kind: string; type: string }[] = []) => ({ types, items }) as unknown as DataTransfer;

describe("composer drop (plan 76)", () => {
  it("only a drag with files counts; text and ProseMirror's own drags don't", () => {
    expect(dragFiles(data(["text/plain", "text/html"]))).toBeNull();
    expect(dragFiles(null)).toBeNull();
    expect(dragFiles(data(["Files"], [{ kind: "file", type: "image/png" }, { kind: "file", type: "application/pdf" }, { kind: "file", type: "" }, { kind: "string", type: "text/uri-list" }]))).toEqual({ images: 1, others: 1, unknown: 1 });
    // a browser that lists nothing until the drop: one file of unknown type
    expect(dragFiles(data(["Files"]))).toEqual({ images: 0, others: 0, unknown: 1 });
  });

  it("says what a drop does where the pointer is", () => {
    const files = (images: number, others = 0, unknown = 0) => ({ images, others, unknown });
    expect(dropLabel({ text: true, files: files(1), blocked: false })).toMatchObject({ label: "Drop to place the image here", inline: true });
    expect(dropLabel({ text: true, files: files(2), blocked: false }).label).toBe("Drop to place the images here");
    expect(dropLabel({ text: true, files: files(1, 1), blocked: false }).label).toBe("Drop to place the images here and attach the rest");
    expect(dropLabel({ text: true, files: files(0, 2), blocked: false })).toMatchObject({ label: "Drop to attach", inline: false, hint: undefined });
    expect(dropLabel({ text: false, files: files(1), blocked: false })).toMatchObject({ label: "Drop to attach", hint: "Drop on the text to place images in it" });
    expect(dropLabel({ text: true, files: files(1), blocked: true }).label).toBe("Can’t add files while sending");
  });
});

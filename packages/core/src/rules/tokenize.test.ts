import { expect, it } from "vitest";
import { tokenize } from "./evaluate";

/** unicode61 remove_diacritics 2, as the general path computes it (no shortcuts). */
function reference(text: string): string[] {
  if (!text) return [];
  return text.normalize("NFD").replace(/(\p{Script=Latin})[̀-ͯ]+/gu, "$1").normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}

it("the ASCII and Latin-1 shortcuts tokenize exactly like the general path", () => {
  let seed = 9;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabets = [
    () => String.fromCharCode(32 + Math.floor(rand() * 95)),
    () => String.fromCharCode(Math.floor(rand() * 256)),
    () => " áéíóúñüçÁÉÍÓÚÑÜÇàèìòùâêîôûãõäëïöÿßæøåÆØÅ¿¡«»ºª°µ´¨×÷"[Math.floor(rand() * 60)]!,
    () => ["é", "ﬁ", "Ελληνικά", "й", "😀", "가", "Σ", "ς"][Math.floor(rand() * 8)]!,
  ];
  for (let i = 0; i < 5000; i++) {
    let text = "";
    const n = Math.floor(rand() * 60);
    const mix = Math.floor(rand() * alphabets.length);
    for (let j = 0; j < n; j++) text += alphabets[rand() < 0.8 ? mix : Math.floor(rand() * alphabets.length)]!();
    expect(tokenize(text), JSON.stringify(text)).toEqual(reference(text));
  }
});

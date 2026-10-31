import type { HomeDesign } from "./types";

export const Bento: HomeDesign = ({ copy }) => (
  <main id="main">
    <h1>{copy.hero.title}</h1>
  </main>
);

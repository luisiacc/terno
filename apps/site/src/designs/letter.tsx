import type { HomeDesign } from "./types";

export const Letter: HomeDesign = ({ copy }) => (
  <main id="main">
    <h1>{copy.hero.title}</h1>
  </main>
);

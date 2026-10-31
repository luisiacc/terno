import type { HomeDesign } from "./types";

export const Atelier: HomeDesign = ({ copy }) => (
  <main id="main">
    <h1>{copy.hero.title}</h1>
  </main>
);

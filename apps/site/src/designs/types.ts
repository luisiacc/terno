import type { SiteCopy } from "../copy";
import type { Route } from "../site";

/** A home page design (plan 96): the same copy and shots, its own look. Renders everything inside <body>. */
export type HomeDesign = (props: { copy: SiteCopy; route: Route }) => React.ReactElement;

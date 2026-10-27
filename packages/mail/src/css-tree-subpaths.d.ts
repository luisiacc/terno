// css-tree publishes these portable entry points; DefinitelyTyped declares only the root.
declare module "css-tree/parser" {
  import type * as Css from "css-tree";
  const parse: typeof Css.parse;
  export default parse;
}
declare module "css-tree/tokenizer" {
  import type * as Css from "css-tree";
  export const tokenize: typeof Css.tokenize;
  export const tokenTypes: typeof Css.tokenTypes;
}
declare module "css-tree/utils" {
  import type * as Css from "css-tree";
  export const ident: typeof Css.ident;
}

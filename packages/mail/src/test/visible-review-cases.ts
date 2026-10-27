export interface VisibleReviewCase {
  name: string;
  html: string;
  text: string;
  value: string;
  query: string;
  matches: boolean;
}

export const visibleReviewCases: VisibleReviewCase[] = [
  { name: "F1 invalid priority cannot override important hiding", html: '<p style="display:none!important;display:block!bogus">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 invalid priority cannot override ordinary hiding", html: '<p style="display:none;display:block!bogus">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 invalid hiding priority leaves visible policy", html: '<p style="display:none!bogus">Useful policy</p>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F1 valid uppercase priority keeps hiding", html: '<p style="display:none!IMPORTANT;display:block">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 valid escaped priority keeps hiding", html: '<p style="display:none!\\69mportant;display:block">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 ordinary last valid declaration stays visible", html: '<p style="display:none;display:block">Useful policy</p>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F1 priority comments remain valid", html: '<p style="display:none!/**/IMPORTANT;display:block">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 bare priority cannot override hiding", html: '<p style="display:none;display:block!">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 repeated priority cannot override hiding", html: '<p style="display:none;display:block!important!important">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F1 trailing tokens cannot override hiding", html: '<p style="display:none;display:block!important trailing">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F2 html wrapper hidden attribute is removed by reader", html: '<html hidden><body><p>Useful policy</p></body></html>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 body wrapper display does not hide reader content", html: '<body hidden style="display:none"><p>Useful policy</p></body>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 body wrapper visibility is not inherited", html: '<body style="visibility:hidden"><span>Useful policy</span></body>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 html wrapper visibility is not inherited", html: '<html style="visibility:hidden"><body><span>Useful policy</span></body></html>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 body wrapper opacity is discarded", html: '<body style="opacity:0"><p>Useful policy</p></body>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 html wrapper display and opacity are discarded", html: '<html style="display:none;opacity:0"><body><p>Useful policy</p></body></html>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F2 wrapper stripping preserves descendant hiding", html: '<body hidden><div style="display:none">phantomneedle</div><p>Useful policy</p></body>', text: "Useful policy", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F2 ordinary descendant visibility stays inherited", html: '<body><div style="visibility:hidden"><span>phantomneedle</span></div><p>Useful policy</p></body>', text: "Useful policy", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 shorthand keeps horizontal clipping after vertical visible", html: '<div style="max-height:0;overflow:hidden;overflow-y:visible">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 later shorthand clips both axes", html: '<div style="max-height:0;overflow-y:visible;overflow:hidden">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 important shorthand protects each axis", html: '<div style="max-height:0;overflow:hidden!important;overflow-y:visible">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 important vertical override still computes auto", html: '<div style="max-height:0;overflow:hidden;overflow-y:visible!important">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 horizontal longhand controls vertical computation", html: '<div style="max-height:0;overflow-x:hidden;overflow-y:visible">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 visible shorthand genuinely resets both axes", html: '<div style="max-height:0;overflow:hidden;overflow:visible">Useful policy</div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F3 both visible longhands restore visible overflow", html: '<div style="max-height:0;overflow:hidden;overflow-y:visible;overflow-x:visible">Useful policy</div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F3 two keyword shorthand clips vertical content", html: '<div style="max-height:0;overflow:visible hidden">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 two keyword shorthand normalizes vertical visible", html: '<div style="max-height:0;overflow:hidden visible">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F3 invalid shorthand pair changes neither axis", html: '<div style="max-height:0;overflow:visible;overflow:hidden bogus">Useful policy</div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F3 normalization follows final specified winners", html: '<div style="max-height:0;overflow-x:hidden;overflow-y:visible;overflow-x:clip">Useful policy</div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F3 explicit vertical auto clips zero height", html: '<div style="max-height:0;overflow-y:auto">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F4 block spans retain visible phrase boundaries", html: '<span style="display:block">Visible</span><span style="display:block">phrase</span>', text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true },
  { name: "F4 inline divs retain word joins", html: '<div style="display:inline">un</div><div style="display:inline">broken</div>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 inline divs do not invent a matching phrase", html: '<div style="display:inline">un</div><div style="display:inline">broken</div>', text: "unbroken", value: "un broken", query: '"un broken"', matches: false },
  { name: "F4 contents contributes no wrapper boundary", html: '<div style="display:contents">un</div><div style="display:contents">broken</div>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 contents retains descendant block boundaries", html: '<span style="display:contents"><div>Visible</div><div>phrase</div></span>', text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true },
  { name: "F4 inline blocks join neighboring words", html: '<div style="display:inline-block">un</div><div style="display:inline-block">broken</div>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 inline flex joins neighboring words", html: '<div style="display:inline-flex">un</div><div style="display:inline-flex">broken</div>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 inline grid joins neighboring words", html: '<div style="display:inline-grid">un</div><div style="display:inline-grid">broken</div>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 inline table retains cell separators", html: '<table style="display:inline-table"><tr><td>Visible</td><td>phrase</td></tr></table>', text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true },
  { name: "F4 default block tags retain phrase boundaries", html: '<div>Visible</div><div>phrase</div>', text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true },
  { name: "F4 br is suppressed before line handling", html: '<span>un</span><br style="display:none"><span>broken</span>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "F4 visible br retains a phrase boundary", html: '<span>Visible</span><br><span>phrase</span>', text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true },
];

const resetCases = [
  { property: "display", hiding: "display:none", protected: "display:none!important" },
  { property: "opacity", hiding: "opacity:0", protected: "opacity:0!important" },
  { property: "max-height", hiding: "max-height:0;overflow:hidden", protected: "max-height:0!important;overflow:hidden" },
  { property: "overflow", hiding: "max-height:0;overflow:hidden", protected: "max-height:0;overflow:hidden!important" },
  { property: "overflow-x", hiding: "max-height:0;overflow:hidden;overflow-y:visible", protected: "max-height:0;overflow-x:hidden!important;overflow-y:visible" },
  { property: "overflow-y", hiding: "max-height:0;overflow:hidden;overflow-x:visible", protected: "max-height:0;overflow-y:hidden!important;overflow-x:visible" },
];
for (const fixture of resetCases) {
  for (const reset of ["initial", "unset"]) visibleReviewCases.push({ name: `F5 ${fixture.property} ${reset} restores visible content`, html: `<p style="${fixture.hiding};${fixture.property}:${reset}">Useful policy</p>`, text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true });
  visibleReviewCases.push({ name: `F5 ${fixture.property} important hiding beats lower priority reset`, html: `<p style="${fixture.protected};${fixture.property}:initial">phantomneedle</p><p>Useful</p>`, text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
  visibleReviewCases.push({ name: `F5 ${fixture.property} equal important reset restores content`, html: `<p style="${fixture.protected};${fixture.property}:initial!important">Useful policy</p>`, text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true });
}
visibleReviewCases.push(
  { name: "F5 initial visibility overrides inherited hiding", html: '<div style="visibility:hidden"><span style="visibility:initial">Useful policy</span></div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "F5 unset visibility still inherits hiding", html: '<div style="visibility:hidden"><span style="visibility:visible;visibility:unset">phantomneedle</span></div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "F5 invalid reset keyword cannot undo hiding", html: '<p style="display:none;display:initial-bogus">phantomneedle</p><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);

for (const tag of ["plaintext", "xmp", "noembed", "noframes", "title", "script", "style", "iframe", "template"]) visibleReviewCases.push({ name: `R2-F1 sanitizer drops ${tag} content`, html: `<p>Useful</p><${tag} style="display:block">phantomneedle</${tag}>`, text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push({ name: "R2-F1 untouched plaintext consumes the raw remainder", html: '<p>Useful</p><plaintext>phantomneedle', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push({ name: "R2-F1 plaintext raw descendants never become body words", html: '<p>Useful</p><PLAINTEXT><b>phantomneedle</b>&#112;hantomneedle', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push(
  { name: "R2-F1 body noscript subtree is discarded by reader", html: '<p>Useful</p><noscript>phantomneedle</noscript><p>Tail</p>', text: "Useful Tail", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F1 body noscript markup is discarded by reader", html: '<p>Useful</p><noscript><b>phantomneedle</b></noscript><p>Tail</p>', text: "Useful Tail", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F1 head noscript text reparented into body remains useful", html: '<noscript>Useful policy</noscript><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
);

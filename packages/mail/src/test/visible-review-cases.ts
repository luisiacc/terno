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

for (const tag of ["plaintext", "xmp", "noembed", "noframes", "script", "style", "iframe", "template"]) visibleReviewCases.push({ name: `R2-F1 sanitizer drops ${tag} content`, html: `<p>Useful</p><${tag} style="display:block">phantomneedle</${tag}>`, text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push({ name: "R2-F1 untouched plaintext consumes the raw remainder", html: '<p>Useful</p><plaintext>phantomneedle', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push({ name: "R2-F1 plaintext raw descendants never become body words", html: '<p>Useful</p><PLAINTEXT><b>phantomneedle</b>&#112;hantomneedle', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push(
  { name: "R2-F1 body noscript subtree is discarded by reader", html: '<p>Useful</p><noscript>phantomneedle</noscript><p>Tail</p>', text: "Useful Tail", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F1 body noscript markup is discarded by reader", html: '<p>Useful</p><noscript><b>phantomneedle</b></noscript><p>Tail</p>', text: "Useful Tail", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F1 head noscript text reparented into body remains useful", html: '<noscript>Useful policy</noscript><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
);
for (const hidden of [" until-found ", "&#32;until-found&#32;", "&#9;UNTIL-FOUND&#10;", "&nbsp;until-found&nbsp;", "until-found"]) visibleReviewCases.push({ name: `R2-F2 normalized hidden ${hidden}`, html: `<div hidden="${hidden}" style="display:block">phantomneedle</div><p>Useful</p>`, text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visibleReviewCases.push(
  { name: "R2-F2 ordinary hidden still permits authored display", html: '<div hidden=" ordinary " style="display:block">Useful policy</div>', text: "Useful policy", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F2 absent display never overrides ordinary hidden", html: '<div hidden>phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F2 invalid display never overrides ordinary hidden", html: '<div hidden style="display:bogus">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);
visibleReviewCases.push(
  { name: "R2-F3 unknown hidden wrapper is unwrapped", html: '<foo hidden>Useful policy</foo><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 custom display wrapper is unwrapped", html: '<mail-note style="display:none">Useful policy</mail-note><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 listing visibility is discarded", html: '<listing style="visibility:hidden">Useful policy</listing><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 object fallback remains useful", html: '<object>Useful policy</object><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 object own hiding is discarded", html: '<object hidden style="opacity:0">Useful policy</object><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 applet fallback is unwrapped", html: '<applet hidden>Useful policy</applet><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 legacy multicol is unwrapped", html: '<multicol style="visibility:hidden">Useful policy</multicol><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 portal fallback is unwrapped", html: '<portal style="display:none">Useful policy</portal><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 unwrapped block styling does not split words", html: '<foo style="display:block">un</foo><foo style="display:block">broken</foo>', text: "unbroken", value: "unbroken", query: "unbroken", matches: true },
  { name: "R2-F3 unwrapped styling does not invent a phrase", html: '<foo style="display:block">un</foo><foo style="display:block">broken</foo>', text: "unbroken", value: "un broken", query: '"un broken"', matches: false },
  { name: "R2-F3 unwrap preserves parent inherited visibility", html: '<div style="visibility:hidden"><foo style="visibility:visible">phantomneedle</foo></div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F3 retained descendant can override inherited visibility", html: '<div style="visibility:hidden"><foo><b style="visibility:visible">Useful policy</b></foo></div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F3 retained span hiding stays effective", html: '<span hidden>phantomneedle</span><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);

// Public DOMPurify3.4.17/Chromium156 output; native marquee/selected-option paint is outside this text contract.
export const visiblePolicyCases: Pick<VisibleReviewCase, "name" | "html" | "text">[] = [
  {
    "name": "R2-F3 public sanitizer catalog a",
    "html": "<p>Useful</p><a hidden data-probe=\"a\">policytoken</a><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog abbr",
    "html": "<p>Useful</p><abbr hidden data-probe=\"abbr\">policytoken</abbr><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog acronym",
    "html": "<p>Useful</p><acronym hidden data-probe=\"acronym\">policytoken</acronym><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog address",
    "html": "<p>Useful</p><address hidden data-probe=\"address\">policytoken</address><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog applet",
    "html": "<p>Useful</p><applet hidden data-probe=\"applet\">policytoken</applet><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog area",
    "html": "<p>Useful</p><area hidden data-probe=\"area\"></area><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog article",
    "html": "<p>Useful</p><article hidden data-probe=\"article\">policytoken</article><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog aside",
    "html": "<p>Useful</p><aside hidden data-probe=\"aside\">policytoken</aside><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog audio",
    "html": "<p>Useful</p><audio hidden data-probe=\"audio\">policytoken</audio><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog b",
    "html": "<p>Useful</p><b hidden data-probe=\"b\">policytoken</b><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog base",
    "html": "<p>Useful</p><base hidden data-probe=\"base\"></base><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog basefont",
    "html": "<p>Useful</p><basefont hidden data-probe=\"basefont\"></basefont><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog bdi",
    "html": "<p>Useful</p><bdi hidden data-probe=\"bdi\">policytoken</bdi><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog bdo",
    "html": "<p>Useful</p><bdo hidden data-probe=\"bdo\">policytoken</bdo><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog big",
    "html": "<p>Useful</p><big hidden data-probe=\"big\">policytoken</big><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog blink",
    "html": "<p>Useful</p><blink hidden data-probe=\"blink\">policytoken</blink><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog blockquote",
    "html": "<p>Useful</p><blockquote hidden data-probe=\"blockquote\">policytoken</blockquote><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog body",
    "html": "<p>Useful</p><body hidden data-probe=\"body\">policytoken</body><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog br",
    "html": "<p>Useful</p><br hidden data-probe=\"br\"></br><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog button",
    "html": "<p>Useful</p><button hidden data-probe=\"button\">policytoken</button><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog canvas",
    "html": "<p>Useful</p><canvas hidden data-probe=\"canvas\">policytoken</canvas><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog caption",
    "html": "<p>Useful</p><table><caption hidden data-probe=\"caption\">policytoken</caption></table><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog center",
    "html": "<p>Useful</p><center hidden data-probe=\"center\">policytoken</center><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog cite",
    "html": "<p>Useful</p><cite hidden data-probe=\"cite\">policytoken</cite><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog code",
    "html": "<p>Useful</p><code hidden data-probe=\"code\">policytoken</code><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog col",
    "html": "<p>Useful</p><table><colgroup><col hidden data-probe=\"col\"></col></colgroup></table><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog colgroup",
    "html": "<p>Useful</p><table><colgroup hidden data-probe=\"colgroup\">policytoken</colgroup></table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog command",
    "html": "<p>Useful</p><command hidden data-probe=\"command\">policytoken</command><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog content",
    "html": "<p>Useful</p><content hidden data-probe=\"content\">policytoken</content><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog data",
    "html": "<p>Useful</p><data hidden data-probe=\"data\">policytoken</data><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog datalist",
    "html": "<p>Useful</p><datalist hidden data-probe=\"datalist\">policytoken</datalist><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dd",
    "html": "<p>Useful</p><dd hidden data-probe=\"dd\">policytoken</dd><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog del",
    "html": "<p>Useful</p><del hidden data-probe=\"del\">policytoken</del><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog details",
    "html": "<p>Useful</p><details hidden data-probe=\"details\">policytoken</details><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dfn",
    "html": "<p>Useful</p><dfn hidden data-probe=\"dfn\">policytoken</dfn><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dialog",
    "html": "<p>Useful</p><dialog hidden data-probe=\"dialog\">policytoken</dialog><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dir",
    "html": "<p>Useful</p><dir hidden data-probe=\"dir\">policytoken</dir><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog div",
    "html": "<p>Useful</p><div hidden data-probe=\"div\">policytoken</div><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dl",
    "html": "<p>Useful</p><dl hidden data-probe=\"dl\">policytoken</dl><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog dt",
    "html": "<p>Useful</p><dt hidden data-probe=\"dt\">policytoken</dt><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog em",
    "html": "<p>Useful</p><em hidden data-probe=\"em\">policytoken</em><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog embed",
    "html": "<p>Useful</p><embed hidden data-probe=\"embed\"></embed><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog fieldset",
    "html": "<p>Useful</p><fieldset hidden data-probe=\"fieldset\">policytoken</fieldset><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog figcaption",
    "html": "<p>Useful</p><figcaption hidden data-probe=\"figcaption\">policytoken</figcaption><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog figure",
    "html": "<p>Useful</p><figure hidden data-probe=\"figure\">policytoken</figure><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog font",
    "html": "<p>Useful</p><font hidden data-probe=\"font\">policytoken</font><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog footer",
    "html": "<p>Useful</p><footer hidden data-probe=\"footer\">policytoken</footer><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog form",
    "html": "<p>Useful</p><form hidden data-probe=\"form\">policytoken</form><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog frame",
    "html": "<p>Useful</p><frame hidden data-probe=\"frame\"></frame><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog frameset",
    "html": "<p>Useful</p><frameset hidden data-probe=\"frameset\">policytoken</frameset><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h1",
    "html": "<p>Useful</p><h1 hidden data-probe=\"h1\">policytoken</h1><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h2",
    "html": "<p>Useful</p><h2 hidden data-probe=\"h2\">policytoken</h2><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h3",
    "html": "<p>Useful</p><h3 hidden data-probe=\"h3\">policytoken</h3><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h4",
    "html": "<p>Useful</p><h4 hidden data-probe=\"h4\">policytoken</h4><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h5",
    "html": "<p>Useful</p><h5 hidden data-probe=\"h5\">policytoken</h5><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog h6",
    "html": "<p>Useful</p><h6 hidden data-probe=\"h6\">policytoken</h6><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog head",
    "html": "<p>Useful</p><head hidden data-probe=\"head\">policytoken</head><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog header",
    "html": "<p>Useful</p><header hidden data-probe=\"header\">policytoken</header><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog hgroup",
    "html": "<p>Useful</p><hgroup hidden data-probe=\"hgroup\">policytoken</hgroup><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog hr",
    "html": "<p>Useful</p><hr hidden data-probe=\"hr\"></hr><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog html",
    "html": "<p>Useful</p><html hidden data-probe=\"html\">policytoken</html><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog i",
    "html": "<p>Useful</p><i hidden data-probe=\"i\">policytoken</i><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog iframe",
    "html": "<p>Useful</p><iframe hidden data-probe=\"iframe\">policytoken</iframe><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog image",
    "html": "<p>Useful</p><image hidden data-probe=\"image\"></image><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog img",
    "html": "<p>Useful</p><img hidden data-probe=\"img\"></img><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog input",
    "html": "<p>Useful</p><input hidden data-probe=\"input\"></input><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog ins",
    "html": "<p>Useful</p><ins hidden data-probe=\"ins\">policytoken</ins><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog kbd",
    "html": "<p>Useful</p><kbd hidden data-probe=\"kbd\">policytoken</kbd><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog keygen",
    "html": "<p>Useful</p><keygen hidden data-probe=\"keygen\"></keygen><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog label",
    "html": "<p>Useful</p><label hidden data-probe=\"label\">policytoken</label><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog legend",
    "html": "<p>Useful</p><legend hidden data-probe=\"legend\">policytoken</legend><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog li",
    "html": "<p>Useful</p><li hidden data-probe=\"li\">policytoken</li><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog link",
    "html": "<p>Useful</p><link hidden data-probe=\"link\"></link><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog listing",
    "html": "<p>Useful</p><listing hidden data-probe=\"listing\">policytoken</listing><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog main",
    "html": "<p>Useful</p><main hidden data-probe=\"main\">policytoken</main><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog map",
    "html": "<p>Useful</p><map hidden data-probe=\"map\">policytoken</map><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog mark",
    "html": "<p>Useful</p><mark hidden data-probe=\"mark\">policytoken</mark><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog menu",
    "html": "<p>Useful</p><menu hidden data-probe=\"menu\">policytoken</menu><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog menuitem",
    "html": "<p>Useful</p><menuitem hidden data-probe=\"menuitem\">policytoken</menuitem><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog meta",
    "html": "<p>Useful</p><meta hidden data-probe=\"meta\"></meta><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog meter",
    "html": "<p>Useful</p><meter hidden data-probe=\"meter\">policytoken</meter><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog multicol",
    "html": "<p>Useful</p><multicol hidden data-probe=\"multicol\">policytoken</multicol><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog nav",
    "html": "<p>Useful</p><nav hidden data-probe=\"nav\">policytoken</nav><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog nextid",
    "html": "<p>Useful</p><nextid hidden data-probe=\"nextid\">policytoken</nextid><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog nobr",
    "html": "<p>Useful</p><nobr hidden data-probe=\"nobr\">policytoken</nobr><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog noembed",
    "html": "<p>Useful</p><noembed hidden data-probe=\"noembed\">policytoken</noembed><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog noframes",
    "html": "<p>Useful</p><noframes hidden data-probe=\"noframes\">policytoken</noframes><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog noscript",
    "html": "<p>Useful</p><noscript hidden data-probe=\"noscript\">policytoken</noscript><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog object",
    "html": "<p>Useful</p><object hidden data-probe=\"object\">policytoken</object><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog ol",
    "html": "<p>Useful</p><ol hidden data-probe=\"ol\">policytoken</ol><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog optgroup",
    "html": "<p>Useful</p><select><optgroup hidden data-probe=\"optgroup\">policytoken</optgroup></select><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog output",
    "html": "<p>Useful</p><output hidden data-probe=\"output\">policytoken</output><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog p",
    "html": "<p>Useful</p><p hidden data-probe=\"p\">policytoken</p><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog param",
    "html": "<p>Useful</p><param hidden data-probe=\"param\"></param><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog picture",
    "html": "<p>Useful</p><picture hidden data-probe=\"picture\">policytoken</picture><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog plaintext",
    "html": "<p>Useful</p><plaintext hidden data-probe=\"plaintext\">policytoken</plaintext><p>Tail</p>",
    "text": "Useful"
  },
  {
    "name": "R2-F3 public sanitizer catalog portal",
    "html": "<p>Useful</p><portal hidden data-probe=\"portal\">policytoken</portal><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog pre",
    "html": "<p>Useful</p><pre hidden data-probe=\"pre\">policytoken</pre><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog progress",
    "html": "<p>Useful</p><progress hidden data-probe=\"progress\">policytoken</progress><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog q",
    "html": "<p>Useful</p><q hidden data-probe=\"q\">policytoken</q><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog rb",
    "html": "<p>Useful</p><rb hidden data-probe=\"rb\">policytoken</rb><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog rp",
    "html": "<p>Useful</p><rp hidden data-probe=\"rp\">policytoken</rp><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog rt",
    "html": "<p>Useful</p><rt hidden data-probe=\"rt\">policytoken</rt><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog rtc",
    "html": "<p>Useful</p><rtc hidden data-probe=\"rtc\">policytoken</rtc><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog ruby",
    "html": "<p>Useful</p><ruby hidden data-probe=\"ruby\">policytoken</ruby><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog s",
    "html": "<p>Useful</p><s hidden data-probe=\"s\">policytoken</s><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog samp",
    "html": "<p>Useful</p><samp hidden data-probe=\"samp\">policytoken</samp><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog script",
    "html": "<p>Useful</p><script hidden data-probe=\"script\">policytoken</script><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog search",
    "html": "<p>Useful</p><search hidden data-probe=\"search\">policytoken</search><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog section",
    "html": "<p>Useful</p><section hidden data-probe=\"section\">policytoken</section><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog select",
    "html": "<p>Useful</p><select hidden data-probe=\"select\">policytoken</select><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog shadow",
    "html": "<p>Useful</p><shadow hidden data-probe=\"shadow\">policytoken</shadow><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog slot",
    "html": "<p>Useful</p><slot hidden data-probe=\"slot\">policytoken</slot><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog small",
    "html": "<p>Useful</p><small hidden data-probe=\"small\">policytoken</small><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog source",
    "html": "<p>Useful</p><source hidden data-probe=\"source\"></source><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog spacer",
    "html": "<p>Useful</p><spacer hidden data-probe=\"spacer\">policytoken</spacer><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog span",
    "html": "<p>Useful</p><span hidden data-probe=\"span\">policytoken</span><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog strike",
    "html": "<p>Useful</p><strike hidden data-probe=\"strike\">policytoken</strike><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog strong",
    "html": "<p>Useful</p><strong hidden data-probe=\"strong\">policytoken</strong><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog style",
    "html": "<p>Useful</p><style hidden data-probe=\"style\">policytoken</style><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog sub",
    "html": "<p>Useful</p><sub hidden data-probe=\"sub\">policytoken</sub><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog summary",
    "html": "<p>Useful</p><summary hidden data-probe=\"summary\">policytoken</summary><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog sup",
    "html": "<p>Useful</p><sup hidden data-probe=\"sup\">policytoken</sup><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog table",
    "html": "<p>Useful</p><table hidden data-probe=\"table\">policytoken</table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog tbody",
    "html": "<p>Useful</p><table><tbody hidden data-probe=\"tbody\">policytoken</tbody></table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog td",
    "html": "<p>Useful</p><table><tbody><tr><td hidden data-probe=\"td\">policytoken</td></tr></tbody></table><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog template",
    "html": "<p>Useful</p><template hidden data-probe=\"template\">policytoken</template><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog textarea",
    "html": "<p>Useful</p><textarea hidden data-probe=\"textarea\">policytoken</textarea><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog tfoot",
    "html": "<p>Useful</p><table><tfoot hidden data-probe=\"tfoot\">policytoken</tfoot></table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog th",
    "html": "<p>Useful</p><table><tbody><tr><th hidden data-probe=\"th\">policytoken</th></tr></tbody></table><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog thead",
    "html": "<p>Useful</p><table><thead hidden data-probe=\"thead\">policytoken</thead></table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog time",
    "html": "<p>Useful</p><time hidden data-probe=\"time\">policytoken</time><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog title",
    "html": "<p>Useful</p><title hidden data-probe=\"title\">policytoken</title><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog tr",
    "html": "<p>Useful</p><table><tbody><tr hidden data-probe=\"tr\">policytoken</tr></tbody></table><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog track",
    "html": "<p>Useful</p><track hidden data-probe=\"track\"></track><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog tt",
    "html": "<p>Useful</p><tt hidden data-probe=\"tt\">policytoken</tt><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog u",
    "html": "<p>Useful</p><u hidden data-probe=\"u\">policytoken</u><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog ul",
    "html": "<p>Useful</p><ul hidden data-probe=\"ul\">policytoken</ul><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog var",
    "html": "<p>Useful</p><var hidden data-probe=\"var\">policytoken</var><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog video",
    "html": "<p>Useful</p><video hidden data-probe=\"video\">policytoken</video><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog wbr",
    "html": "<p>Useful</p><wbr hidden data-probe=\"wbr\"></wbr><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog xmp",
    "html": "<p>Useful</p><xmp hidden data-probe=\"xmp\">policytoken</xmp><p>Tail</p>",
    "text": "Useful Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog foo",
    "html": "<p>Useful</p><foo hidden data-probe=\"foo\">policytoken</foo><p>Tail</p>",
    "text": "Useful policytoken Tail"
  },
  {
    "name": "R2-F3 public sanitizer catalog mail-note",
    "html": "<p>Useful</p><mail-note hidden data-probe=\"mail-note\">policytoken</mail-note><p>Tail</p>",
    "text": "Useful policytoken Tail"
  }
];

const displayMatrix: [string, string, string][] = [
  ["none", "Tail", "Tail"], ["contents", "Useful policy Tail", "Useful policy Tail"],
  ["inline", "Tail", "Useful policy Tail"], ["inline-block", "Tail", "Tail"],
  ["block", "Tail", "Tail"], ["flow-root", "Tail", "Tail"], ["list-item", "Tail", "Tail"],
  ["flex", "Tail", "Tail"], ["grid", "Tail", "Tail"], ["inline-flex", "Tail", "Tail"], ["inline-grid", "Tail", "Tail"],
  ["table", "Tail", "Useful policy Tail"], ["inline-table", "Tail", "Useful policy Tail"],
  ["table-row-group", "Tail", "Useful policy Tail"], ["table-header-group", "Tail", "Useful policy Tail"],
  ["table-footer-group", "Tail", "Useful policy Tail"], ["table-row", "Tail", "Useful policy Tail"], ["table-cell", "Tail", "Useful policy Tail"],
  ["table-column", "Tail", "Tail"], ["table-column-group", "Tail", "Tail"], ["table-caption", "Tail", "Tail"],
];
for (const [display, opacityText, heightText] of displayMatrix) {
  visiblePolicyCases.push({ name: `R2-F4 display ${display} opacity matrix`, html: `<div style="display:${display};opacity:0"><b>Useful policy</b></div><p>Tail</p>`, text: opacityText });
  visiblePolicyCases.push({ name: `R2-F4 display ${display} max-height matrix`, html: `<div style="display:${display};max-height:0;overflow:hidden"><b>Useful policy</b></div><p>Tail</p>`, text: heightText });
}
visibleReviewCases.push(
  { name: "R2-F4 contents opacity does not suppress descendants", html: '<div style="display:contents;opacity:0"><b>Useful policy</b></div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 contents cannot clip descendants", html: '<div style="display:contents;max-height:0;overflow:hidden">Useful policy</div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 inline cannot acquire max-height clipping", html: '<div style="display:inline;max-height:0;overflow:hidden">Useful policy</div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 initial display cancels block clipping", html: '<p style="display:block;max-height:0;overflow:hidden;display:initial">Useful policy</p><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 unset display cancels block clipping", html: '<p style="display:block;max-height:0;overflow:hidden;display:unset">Useful policy</p><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 default inline span stays useful", html: '<span style="max-height:0;overflow:hidden">Useful policy</span><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 default slot is boxless", html: '<slot style="opacity:0;max-height:0;overflow:hidden">Useful policy</slot><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 boxless retained slot still inherits visibility", html: '<slot style="opacity:0;visibility:hidden">phantomneedle<span style="visibility:visible">Useful policy</span></slot><p>Tail</p>', text: "Useful policy Tail", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F4 native table max-height does not clip text", html: '<table style="max-height:0;overflow:hidden"><tr><td>Useful policy</td></tr></table><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 table row max-height does not clip text", html: '<div style="display:table-row;max-height:0;overflow:hidden">Useful policy</div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 table cell max-height does not clip text", html: '<div style="display:table-cell;max-height:0;overflow:hidden">Useful policy</div><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2-F4 important block still clips", html: '<div style="display:block!important;display:contents;max-height:0;overflow:hidden">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F4 ordinary block clipping remains hidden", html: '<div style="max-height:0;overflow:hidden">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F4 inline block clipping remains hidden", html: '<div style="display:inline-block;max-height:0;overflow:hidden">phantomneedle</div><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2-F4 ordinary inline opacity remains hidden", html: '<span style="opacity:0">phantomneedle</span><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);

for (const tag of ["center", "dir", "menu", "hgroup", "search", "legend", "summary"]) {
  visibleReviewCases.push({ name: `R2-F5 retained ${tag} has default block boundaries`, html: `<${tag}>Visible</${tag}><${tag}>phrase</${tag}>`, text: "Visible phrase", value: "visible phrase", query: '"visible phrase"', matches: true });
  for (const display of ["inline", "contents"]) {
    const text = tag === "legend" && display === "inline" ? "un broken" : "unbroken";
    visibleReviewCases.push({ name: `R2-F5 ${tag} ${display} resolved boundaries`, html: `<${tag} style="display:${display}">un</${tag}><${tag} style="display:${display}">broken</${tag}>`, text, value: text, query: text === "unbroken" ? "unbroken" : '"un broken"', matches: true });
  }
}
visibleReviewCases.push({ name: "R2-F5 default center does not override hidden", html: '<center hidden>phantomneedle</center><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false });
visiblePolicyCases.push(
  { name: "R2-F5 footer table groups preserve row boundaries", html: '<table><tfoot><tr><td>Visible</td></tr><tr><td>phrase</td></tr></tfoot></table>', text: "Visible phrase" },
  { name: "R2-F5 retained open details has block boundaries", html: '<details open>Visible</details><details open>phrase</details>', text: "Visible phrase" },
  { name: "R2-F5 retained open dialog has block boundaries", html: '<dialog open>Visible</dialog><dialog open>phrase</dialog>', text: "Visible phrase" },
);
visibleReviewCases.push(
  { name: "R2-F3 body title authored display is retained", html: '<p>Useful</p><title style="display:block">phantomneedle</title>', text: "Useful phantomneedle", value: "phantomneedle", query: "phantomneedle", matches: true },
  { name: "R2-F3 head title stays outside reader body", html: '<head><title style="display:block">phantomneedle</title></head><body><p>Useful</p></body>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);
visibleReviewCases.push(
  { name: "R2 legend inline height applies after normalization", html: '<legend style="display:inline;max-height:0;overflow:hidden">phantomneedle</legend><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2 legend table cell height applies after normalization", html: '<legend style="display:table-cell;max-height:0;overflow:hidden">phantomneedle</legend><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2 legend table column text has a real block box", html: '<legend style="display:table-column">Useful policy</legend><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2 legend table column group text has a real block box", html: '<legend style="display:table-column-group">Useful policy</legend><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2 legend inline table keeps positive height", html: '<legend style="display:inline-table;max-height:0;overflow:hidden">Useful policy</legend><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2 legend important inline beats contents before normalization", html: '<legend style="display:inline!important;display:contents;max-height:0;overflow:hidden">phantomneedle</legend><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2 legend contents remains boxless", html: '<legend style="display:contents;opacity:0;max-height:0;overflow:hidden">Useful policy</legend><p>Tail</p>', text: "Useful policy Tail", value: "useful policy", query: '"useful policy"', matches: true },
  { name: "R2 legend default still obeys ordinary hidden", html: '<legend hidden>phantomneedle</legend><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
  { name: "R2 legend until found remains excluded", html: '<legend hidden=" until-found " style="display:inline">phantomneedle</legend><p>Useful</p>', text: "Useful", value: "phantomneedle", query: "phantomneedle", matches: false },
);

visiblePolicyCases.push(
  {
    "name": "R2 legend public matrix display none opacity:0",
    "html": "<legend style=\"display:none;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display none max-height:0;overflow:hidden",
    "html": "<legend style=\"display:none;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display contents opacity:0",
    "html": "<legend style=\"display:contents;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Useful policy Tail"
  },
  {
    "name": "R2 legend public matrix display contents max-height:0;overflow:hidden",
    "html": "<legend style=\"display:contents;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Useful policy Tail"
  },
  {
    "name": "R2 legend public matrix display inline opacity:0",
    "html": "<legend style=\"display:inline;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline max-height:0;overflow:hidden",
    "html": "<legend style=\"display:inline;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-block opacity:0",
    "html": "<legend style=\"display:inline-block;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-block max-height:0;overflow:hidden",
    "html": "<legend style=\"display:inline-block;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display block opacity:0",
    "html": "<legend style=\"display:block;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display block max-height:0;overflow:hidden",
    "html": "<legend style=\"display:block;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display flow-root opacity:0",
    "html": "<legend style=\"display:flow-root;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display flow-root max-height:0;overflow:hidden",
    "html": "<legend style=\"display:flow-root;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display list-item opacity:0",
    "html": "<legend style=\"display:list-item;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display list-item max-height:0;overflow:hidden",
    "html": "<legend style=\"display:list-item;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display flex opacity:0",
    "html": "<legend style=\"display:flex;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display flex max-height:0;overflow:hidden",
    "html": "<legend style=\"display:flex;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display grid opacity:0",
    "html": "<legend style=\"display:grid;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display grid max-height:0;overflow:hidden",
    "html": "<legend style=\"display:grid;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-flex opacity:0",
    "html": "<legend style=\"display:inline-flex;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-flex max-height:0;overflow:hidden",
    "html": "<legend style=\"display:inline-flex;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-grid opacity:0",
    "html": "<legend style=\"display:inline-grid;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-grid max-height:0;overflow:hidden",
    "html": "<legend style=\"display:inline-grid;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table opacity:0",
    "html": "<legend style=\"display:table;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Useful policy Tail"
  },
  {
    "name": "R2 legend public matrix display inline-table opacity:0",
    "html": "<legend style=\"display:inline-table;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display inline-table max-height:0;overflow:hidden",
    "html": "<legend style=\"display:inline-table;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Useful policy Tail"
  },
  {
    "name": "R2 legend public matrix display table-row-group opacity:0",
    "html": "<legend style=\"display:table-row-group;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-row-group max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-row-group;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-header-group opacity:0",
    "html": "<legend style=\"display:table-header-group;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-header-group max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-header-group;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-footer-group opacity:0",
    "html": "<legend style=\"display:table-footer-group;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-footer-group max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-footer-group;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-row opacity:0",
    "html": "<legend style=\"display:table-row;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-row max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-row;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-cell opacity:0",
    "html": "<legend style=\"display:table-cell;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-cell max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-cell;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-column opacity:0",
    "html": "<legend style=\"display:table-column;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-column max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-column;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-column-group opacity:0",
    "html": "<legend style=\"display:table-column-group;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-column-group max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-column-group;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-caption opacity:0",
    "html": "<legend style=\"display:table-caption;opacity:0\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  },
  {
    "name": "R2 legend public matrix display table-caption max-height:0;overflow:hidden",
    "html": "<legend style=\"display:table-caption;max-height:0;overflow:hidden\"><b>Useful policy</b></legend><p>Tail</p>",
    "text": "Tail"
  }
);

visibleReviewCases.push(
  {
    "name": "R3-F1 rp default content remains hidden",
    "html": "<p>Useful</p><rp>phantomneedle</rp>",
    "text": "Useful",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F1 rp invalid display does not expose hidden content",
    "html": "<p>Useful</p><rp style=\"display:bogus\">phantomneedle</rp>",
    "text": "Useful",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F1 rp authored block exposes useful text",
    "html": "<rp style=\"display:block\">Useful policy</rp><p>Tail</p>",
    "text": "Useful policy Tail",
    "value": "useful policy",
    "query": "\"useful policy\"",
    "matches": true
  },
  {
    "name": "R3-F1 rp authored inline restores word join",
    "html": "<span>un</span><rp style=\"display:inline\">broken</rp>",
    "text": "unbroken",
    "value": "unbroken",
    "query": "unbroken",
    "matches": true
  },
  {
    "name": "R3-F1 br default ignores max-height clipping preserves phrase",
    "html": "<span>Visible</span><br style=\"max-height:0;overflow:hidden\"><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F1 br default ignores max-height clipping no joined word",
    "html": "<span>Visible</span><br style=\"max-height:0;overflow:hidden\"><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F1 br default preserves phrase control",
    "html": "<span>Visible</span><br><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F1 br display-none preserves join control",
    "html": "<span>Visible</span><br style=\"display:none\"><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F1 rp authored reset/priority initial",
    "html": "<span>un</span><rp style=\"display:initial\">broken</rp>",
    "text": "unbroken",
    "value": "unbroken",
    "query": "unbroken",
    "matches": true
  },
  {
    "name": "R3-F1 rp authored reset/priority unset",
    "html": "<span>un</span><rp style=\"display:unset\">broken</rp>",
    "text": "unbroken",
    "value": "unbroken",
    "query": "unbroken",
    "matches": true
  },
  {
    "name": "R3-F1 rp authored reset/priority none;display:inline!important;display:none",
    "html": "<span>un</span><rp style=\"display:none;display:inline!important;display:none\">broken</rp>",
    "text": "unbroken",
    "value": "unbroken",
    "query": "unbroken",
    "matches": true
  },
  {
    "name": "R3-F1 rp authored reset/priority none!important;display:inline",
    "html": "<span>un</span><rp style=\"display:none!important;display:inline\">broken</rp>",
    "text": "un",
    "value": "unbroken",
    "query": "unbroken",
    "matches": false
  },
  {
    "name": "R3-F1 ordinary hidden BR stays removed",
    "html": "<span>Visible</span><br hidden><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  }
);

visibleReviewCases.push(
  {
    "name": "R3-F2 opacity zero block preserves phrase",
    "html": "<span>Visible</span><div style=\"opacity:0\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity zero block does not invent joined word",
    "html": "<span>Visible</span><div style=\"opacity:0\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 zero height clipped block preserves phrase",
    "html": "<span>Visible</span><div style=\"max-height:0;overflow:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 zero height clipped block does not invent joined word",
    "html": "<span>Visible</span><div style=\"max-height:0;overflow:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity zero inline with descendant block preserves phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity zero inline with descendant block does not invent joined word",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 display none remains boundary free",
    "html": "<span>Visible</span><div style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
  "name": "R3-F2 inline opacity remains boundary free [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\">phantomneedle</span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
    "name": "R3-F2 visibility hidden block preserves phrase",
    "html": "<span>Visible</span><div style=\"visibility:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity block visible phrase",
    "html": "<span>Visible</span><div style=\"opacity:0\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity block visiblephrase",
    "html": "<span>Visible</span><div style=\"opacity:0\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity block phantomneedle",
    "html": "<span>Visible</span><div style=\"opacity:0\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 clipped block visible phrase",
    "html": "<span>Visible</span><div style=\"max-height:0;overflow:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 clipped block visiblephrase",
    "html": "<span>Visible</span><div style=\"max-height:0;overflow:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 clipped block phantomneedle",
    "html": "<span>Visible</span><div style=\"max-height:0;overflow:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant block visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline descendant block visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant block phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant BR visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\">phantom<br>needle</span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline descendant BR visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\">phantom<br>needle</span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant BR phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\">phantom<br>needle</span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline unwrapped descendant block visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:none\"><div>phantomneedle</div></unknown></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline unwrapped descendant block visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:none\"><div>phantomneedle</div></unknown></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline unwrapped descendant block phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:none\"><div>phantomneedle</div></unknown></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
  "name": "R3-F2 opacity inline unwrapped atomic descendant visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown><span style=\"display:inline-block\"><div>phantomneedle</div></span></unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity inline unwrapped atomic descendant visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown><span style=\"display:inline-block\"><div>phantomneedle</div></span></unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity inline unwrapped atomic descendant phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown><span style=\"display:inline-block\"><div>phantomneedle</div></span></unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline block containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-block\"><div>phantomneedle</div><br></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity atomic inline block containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-block\"><div>phantomneedle</div><br></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline block containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-block\"><div>phantomneedle</div><br></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
  "name": "R3-F2 clipped atomic inline containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"max-height:0;overflow:hidden;display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 clipped atomic inline containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"max-height:0;overflow:hidden;display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 clipped atomic inline containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"max-height:0;overflow:hidden;display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline flex containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-flex\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity atomic inline flex containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-flex\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline flex containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-flex\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline grid containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-grid\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity atomic inline grid containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-grid\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline grid containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-grid\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline table containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-table\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity atomic inline table containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-table\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity atomic inline table containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0;display:inline-table\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
    "name": "R3-F2 opacity inline descendant removed block visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"display:none\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant removed block visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"display:none\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline descendant removed block phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"display:none\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant ordinary hidden block visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div hidden>phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline descendant ordinary hidden block visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div hidden>phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline descendant ordinary hidden block phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div hidden>phantomneedle</div></span><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
  "name": "R3-F2 opacity inline discarded wrapper display ignored visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:block\">phantomneedle</unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 opacity inline discarded wrapper display ignored visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:block\">phantomneedle</unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 opacity inline discarded wrapper display ignored phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span style=\"opacity:0\"><unknown style=\"display:block\">phantomneedle</unknown></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
    "name": "R3-F2 opacity inline visible descendant cannot restore text visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"opacity:1;visibility:visible\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline visible descendant cannot restore text visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"opacity:1;visibility:visible\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline visible descendant cannot restore text phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><div style=\"opacity:1;visibility:visible\">phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline contents descendant block visible phrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><span style=\"display:contents\"><div>phantomneedle</div></span></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 opacity inline contents descendant block visiblephrase",
    "html": "<span>Visible</span><span style=\"opacity:0\"><span style=\"display:contents\"><div>phantomneedle</div></span></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 opacity inline contents descendant block phantomneedle",
    "html": "<span>Visible</span><span style=\"opacity:0\"><span style=\"display:contents\"><div>phantomneedle</div></span></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 visibility hidden block visible phrase",
    "html": "<span>Visible</span><div style=\"visibility:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 visibility hidden block visiblephrase",
    "html": "<span>Visible</span><div style=\"visibility:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 visibility hidden block phantomneedle",
    "html": "<span>Visible</span><div style=\"visibility:hidden\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 display none block visible phrase",
    "html": "<span>Visible</span><div style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": false
  },
  {
    "name": "R3-F2 display none block visiblephrase",
    "html": "<span>Visible</span><div style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F2 display none block phantomneedle",
    "html": "<span>Visible</span><div style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 ordinary hidden block visible phrase",
    "html": "<span>Visible</span><div hidden>phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": false
  },
  {
    "name": "R3-F2 ordinary hidden block visiblephrase",
    "html": "<span>Visible</span><div hidden>phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F2 ordinary hidden block phantomneedle",
    "html": "<span>Visible</span><div hidden>phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 until found block visible phrase",
    "html": "<span>Visible</span><div hidden=\" Until-Found \" style=\"display:block\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 until found block visiblephrase",
    "html": "<span>Visible</span><div hidden=\" Until-Found \" style=\"display:block\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 until found block phantomneedle",
    "html": "<span>Visible</span><div hidden=\" Until-Found \" style=\"display:block\">phantomneedle</div><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
    "name": "R3-F2 until found inline descendant block visible phrase",
    "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": true
  },
  {
    "name": "R3-F2 until found inline descendant block visiblephrase",
    "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": false
  },
  {
    "name": "R3-F2 until found inline descendant block phantomneedle",
    "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline\"><div>phantomneedle</div></span><span>phrase</span>",
    "text": "Visible phrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  },
  {
  "name": "R3-F2 until found atomic containment visible phrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visible phrase",
  "query": "\"visible phrase\"",
  "matches": true
},
  {
  "name": "R3-F2 until found atomic containment visiblephrase [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "visiblephrase",
  "query": "visiblephrase",
  "matches": false
},
  {
  "name": "R3-F2 until found atomic containment phantomneedle [R4-F2 occupied correction]",
  "html": "<span>Visible</span><span hidden=\"until-found\" style=\"display:inline-block\"><div>phantomneedle</div></span><span>phrase</span>",
  "text": "Visible phrase",
  "value": "phantomneedle",
  "query": "phantomneedle",
  "matches": false
},
  {
    "name": "R3-F2 until found display none removed visible phrase",
    "html": "<span>Visible</span><div hidden=\"until-found\" style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visible phrase",
    "query": "\"visible phrase\"",
    "matches": false
  },
  {
    "name": "R3-F2 until found display none removed visiblephrase",
    "html": "<span>Visible</span><div hidden=\"until-found\" style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "visiblephrase",
    "query": "visiblephrase",
    "matches": true
  },
  {
    "name": "R3-F2 until found display none removed phantomneedle",
    "html": "<span>Visible</span><div hidden=\"until-found\" style=\"display:none\">phantomneedle</div><span>phrase</span>",
    "text": "Visiblephrase",
    "value": "phantomneedle",
    "query": "phantomneedle",
    "matches": false
  }
);

visibleReviewCases.push(
{"name": "R4-F1 style XML-unsafe removal preserves ordinary hidden", "html": "<div hidden style=\"display:block;/*-->*/\">phantomneedle</div><p>Useful</p>", "text": "Useful", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F1 style NBSP trim exposes effective display none", "html": "<div style=\"&nbsp;display:none\">phantomneedle</div><p>Useful</p>", "text": "Useful", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F1 removed style cannot suppress useful text", "html": "<div style=\"display:none;/*-->*/\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail", "value": "useful policy", "query": "\"useful policy\"", "matches": true},
{"name": "R4-F1 removed hidden cannot suppress useful text", "html": "<div hidden=\"-->\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail", "value": "useful policy", "query": "\"useful policy\"", "matches": true},
{"name": "R4-F1 valid authored display overrides retained ordinary hidden", "html": "<div hidden style=\"display:block\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail", "value": "useful policy", "query": "\"useful policy\"", "matches": true},
{"name": "R4-F1 valid display none hides marker", "html": "<div style=\"display:none\">phantomneedle</div><p>Useful</p>", "text": "Useful", "value": "phantomneedle", "query": "phantomneedle", "matches": false}
);

visiblePolicyCases.push(
{"name": "R4-F1 public attribute style trim ASCII", "html": "<div style=\" &#9;&#10;display:none &#9;&#10;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim ASCII", "html": "<div hidden=\" &#9;&#10;until-found &#9;&#10;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim NBSP", "html": "<div style=\"&nbsp;display:none&nbsp;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim NBSP", "html": "<div hidden=\"&nbsp;until-found&nbsp;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim BOM", "html": "<div style=\"&#xfeff;display:none&#xfeff;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim BOM", "html": "<div hidden=\"&#xfeff;until-found&#xfeff;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim EM SPACE", "html": "<div style=\"&#x2003;display:none&#x2003;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim EM SPACE", "html": "<div hidden=\"&#x2003;until-found&#x2003;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim NARROW NBSP", "html": "<div style=\"&#x202f;display:none&#x202f;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim NARROW NBSP", "html": "<div hidden=\"&#x202f;until-found&#x202f;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim NO BREAK FIGURE", "html": "<div style=\"&#x2007;display:none&#x2007;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim NO BREAK FIGURE", "html": "<div hidden=\"&#x2007;until-found&#x2007;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim IDEOGRAPHIC", "html": "<div style=\"&#x3000;display:none&#x3000;\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden trim IDEOGRAPHIC", "html": "<div hidden=\"&#x3000;until-found&#x3000;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute style trim not trimmed ZWSP", "html": "<div style=\"&#x200b;display:none&#x200b;\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden trim not trimmed ZWSP", "html": "<div hidden=\"&#x200b;until-found&#x200b;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute style trim not trimmed NEL", "html": "<div style=\"&#x85;display:none&#x85;\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden trim not trimmed NEL", "html": "<div hidden=\"&#x85;until-found&#x85;\" style=\"display:block\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute style value -->", "html": "<div hidden style=\"display:block;/*-->*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value -->", "html": "<div hidden=\"-->\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value --!>", "html": "<div hidden style=\"display:block;/*--!>*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value --!>", "html": "<div hidden=\"--!>\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value ]>", "html": "<div hidden style=\"display:block;/*]>*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value ]>", "html": "<div hidden=\"]>\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </style", "html": "<div hidden style=\"display:block;/*</style*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </style", "html": "<div hidden=\"</style\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </STYLE", "html": "<div hidden style=\"display:block;/*</STYLE*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </STYLE", "html": "<div hidden=\"</STYLE\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </script", "html": "<div hidden style=\"display:block;/*</script*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </script", "html": "<div hidden=\"</script\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </title", "html": "<div hidden style=\"display:block;/*</title*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </title", "html": "<div hidden=\"</title\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </xmp", "html": "<div hidden style=\"display:block;/*</xmp*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </xmp", "html": "<div hidden=\"</xmp\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </textarea", "html": "<div hidden style=\"display:block;/*</textarea*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </textarea", "html": "<div hidden=\"</textarea\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </noscript", "html": "<div hidden style=\"display:block;/*</noscript*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </noscript", "html": "<div hidden=\"</noscript\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </iframe", "html": "<div hidden style=\"display:block;/*</iframe*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </iframe", "html": "<div hidden=\"</iframe\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </noembed", "html": "<div hidden style=\"display:block;/*</noembed*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </noembed", "html": "<div hidden=\"</noembed\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </noframes", "html": "<div hidden style=\"display:block;/*</noframes*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </noframes", "html": "<div hidden=\"</noframes\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value </stylex", "html": "<div hidden style=\"display:block;/*</stylex*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value </stylex", "html": "<div hidden=\"</stylex\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value &lt;/style", "html": "<div hidden style=\"display:block;/*&lt;/style*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value &lt;/style", "html": "<div hidden=\"&lt;/style\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value --&gt;", "html": "<div hidden style=\"display:block;/*--&gt;*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value --&gt;", "html": "<div hidden=\"--&gt;\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value --!&gt;", "html": "<div hidden style=\"display:block;/*--!&gt;*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value --!&gt;", "html": "<div hidden=\"--!&gt;\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value ]&gt;", "html": "<div hidden style=\"display:block;/*]&gt;*/\">phantomneedle</div><p>Useful</p>", "text": "Useful"},
{"name": "R4-F1 public attribute hidden value ]&gt;", "html": "<div hidden=\"]&gt;\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute style value <!--", "html": "<div hidden style=\"display:block;/*<!--*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value <!--", "html": "<div hidden=\"<!--\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value <![CDATA[", "html": "<div hidden style=\"display:block;/*<![CDATA[*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value <![CDATA[", "html": "<div hidden=\"<![CDATA[\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value -- >", "html": "<div hidden style=\"display:block;/*-- >*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value -- >", "html": "<div hidden=\"-- >\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value </ style", "html": "<div hidden style=\"display:block;/*</ style*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value </ style", "html": "<div hidden=\"</ style\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value </span", "html": "<div hidden style=\"display:block;/*</span*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value </span", "html": "<div hidden=\"</span\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value \\3c /style", "html": "<div hidden style=\"display:block;/*\\3c /style*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value \\3c /style", "html": "<div hidden=\"\\3c /style\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute style value &amp;lt;/style", "html": "<div hidden style=\"display:block;/*&amp;lt;/style*/\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public attribute hidden value &amp;lt;/style", "html": "<div hidden=\"&amp;lt;/style\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol ", "html": "<div hidden=\"\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol ordinary", "html": "<div hidden=\"ordinary\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol until-found", "html": "<div hidden=\"until-found\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol javascript:foo", "html": "<div hidden=\"javascript:foo\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol java&#10;script:foo", "html": "<div hidden=\"java&#10;script:foo\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol data:text/html,x", "html": "<div hidden=\"data:text/html,x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol vbscript:x", "html": "<div hidden=\"vbscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol unknown:x", "html": "<div hidden=\"unknown:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol foo:bar", "html": "<div hidden=\"foo:bar\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol https://invalid.test", "html": "<div hidden=\"https://invalid.test\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol http:x", "html": "<div hidden=\"http:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol ftp:x", "html": "<div hidden=\"ftp:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol ftps:x", "html": "<div hidden=\"ftps:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol mailto:x", "html": "<div hidden=\"mailto:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol tel:x", "html": "<div hidden=\"tel:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol callto:x", "html": "<div hidden=\"callto:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol sms:x", "html": "<div hidden=\"sms:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol cid:x", "html": "<div hidden=\"cid:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol xmpp:x", "html": "<div hidden=\"xmpp:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol matrix:x", "html": "<div hidden=\"matrix:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol &#106;avascript:x", "html": "<div hidden=\"&#106;avascript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public attribute hidden protocol &#0;javascript:x", "html": "<div hidden=\"&#0;javascript:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol /*ordinary*/", "html": "<div hidden=\"/*ordinary*/\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol --", "html": "<div hidden=\"--\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol <x", "html": "<div hidden=\"<x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public attribute hidden protocol display:none", "html": "<div hidden=\"display:none\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"}
);

visiblePolicyCases.push(
{"name": "R4-F1 public hidden embedded literal NEL", "html": "<div hidden=\"java\u0085script:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public style trim literal NEL", "html": "<div style=\"\u0085display:none\u0085\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public hidden embedded literal MONGOLIAN", "html": "<div hidden=\"java\u180escript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public style trim literal MONGOLIAN", "html": "<div style=\"\u180edisplay:none\u180e\">phantomneedle</div><p>Useful</p>", "text": "phantomneedle Useful"},
{"name": "R4-F1 public hidden embedded control0", "html": "<div hidden=\"java\u0000script:x\">Useful policy</div><p>Tail</p>", "text": "Tail"},
{"name": "R4-F1 public hidden embedded control1", "html": "<div hidden=\"java\u0001script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control2", "html": "<div hidden=\"java\u0002script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control3", "html": "<div hidden=\"java\u0003script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control4", "html": "<div hidden=\"java\u0004script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control5", "html": "<div hidden=\"java\u0005script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control6", "html": "<div hidden=\"java\u0006script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control7", "html": "<div hidden=\"java\u0007script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control8", "html": "<div hidden=\"java\bscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control9", "html": "<div hidden=\"java\tscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control10", "html": "<div hidden=\"java\nscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control11", "html": "<div hidden=\"java\u000bscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control12", "html": "<div hidden=\"java\fscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control13", "html": "<div hidden=\"java\rscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control14", "html": "<div hidden=\"java\u000escript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control15", "html": "<div hidden=\"java\u000fscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control16", "html": "<div hidden=\"java\u0010script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control17", "html": "<div hidden=\"java\u0011script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control18", "html": "<div hidden=\"java\u0012script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control19", "html": "<div hidden=\"java\u0013script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control20", "html": "<div hidden=\"java\u0014script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control21", "html": "<div hidden=\"java\u0015script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control22", "html": "<div hidden=\"java\u0016script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control23", "html": "<div hidden=\"java\u0017script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control24", "html": "<div hidden=\"java\u0018script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control25", "html": "<div hidden=\"java\u0019script:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control26", "html": "<div hidden=\"java\u001ascript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control27", "html": "<div hidden=\"java\u001bscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control28", "html": "<div hidden=\"java\u001cscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control29", "html": "<div hidden=\"java\u001dscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control30", "html": "<div hidden=\"java\u001escript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"},
{"name": "R4-F1 public hidden embedded control31", "html": "<div hidden=\"java\u001fscript:x\">Useful policy</div><p>Tail</p>", "text": "Useful policy Tail"}
);

visibleReviewCases.push(
{"name": "R4-F2 inline text visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 inline text visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 inline text phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 inline empty visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 inline empty visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 inline empty phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 inline whitespace visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 inline whitespace visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 inline whitespace phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 inline NBSP visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 inline NBSP visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 inline NBSP phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 inline child block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 inline child block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 inline child block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic text visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic text visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic text phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic empty visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic empty visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic empty phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic whitespace visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic whitespace visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic whitespace phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic NBSP visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic NBSP visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic NBSP phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic child block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic child block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic child block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 contents text visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephantomneedlephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 contents text visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephantomneedlephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 contents text phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephantomneedlephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 removed visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:none;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 removed visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:none;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 removed phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:none;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 ordinary inline width zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 ordinary inline width zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 ordinary inline width zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic width zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic width zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic width zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic clipped width zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic clipped width zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic clipped width zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic width zero padded visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:8px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic width zero padded visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:8px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic width zero padded phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:8px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic empty positive width visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:20px\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic empty positive width visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:20px\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic empty positive width phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:20px\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic clipped height visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;max-height:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic clipped height visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;max-height:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic clipped height phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;max-height:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 visibility hidden inline visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 visibility hidden inline visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 visibility hidden inline phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 visibility visible child visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\"><b style=\"visibility:visible\">Shown</b></span><span id=\"after\">phrase</span>", "text": "VisibleShownphrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 visibility visible child visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\"><b style=\"visibility:visible\">Shown</b></span><span id=\"after\">phrase</span>", "text": "VisibleShownphrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 visibility visible child phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\"><b style=\"visibility:visible\">Shown</b></span><span id=\"after\">phrase</span>", "text": "VisibleShownphrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 opacity visible child suppressed visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"visibility:visible;opacity:1\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 opacity visible child suppressed visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"visibility:visible;opacity:1\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 opacity visible child suppressed phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"visibility:visible;opacity:1\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 only removed child visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"display:none\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 only removed child visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"display:none\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 only removed child phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"display:none\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 only hidden child visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b hidden>phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 only hidden child visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b hidden>phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 only hidden child phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b hidden>phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic only BR visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><br></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic only BR visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><br></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic only BR phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><br></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic empty child block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><div></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic empty child block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><div></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic empty child block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><div></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic width zero padding zero conservative visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic width zero padding zero conservative visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic width zero padding zero conservative phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic width reset initial visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:initial\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 atomic width reset initial visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:initial\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 atomic width reset initial phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:initial\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 atomic width important protects zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 atomic width important protects zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 atomic width important protects zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 nested empty positive atomic child visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><span style=\"display:inline-block;width:20px\"></span></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 nested empty positive atomic child visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><span style=\"display:inline-block;width:20px\"></span></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 nested empty positive atomic child phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><span style=\"display:inline-block;width:20px\"></span></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 genuine visible inline join positive control", "html": "<span>un</span><b>broken</b>", "text": "unbroken", "value": "unbroken", "query": "unbroken", "matches": true}
);

visiblePolicyCases.push(
{"name": "R4-F2 occupancy inline text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy inline empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy inline whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy inline NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy inline child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy block text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:block;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy block empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:block;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy block whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:block;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy block NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:block;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy block child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:block;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy flex atomic text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-flex;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy flex atomic empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-flex;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy flex atomic whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-flex;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy flex atomic NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-flex;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy flex atomic child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-flex;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy grid atomic text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-grid;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy grid atomic empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-grid;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy grid atomic whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-grid;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy grid atomic NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-grid;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy grid atomic child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-grid;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy table atomic text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-table;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy table atomic empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-table;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy table atomic whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-table;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy table atomic NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-table;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy table atomic child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-table;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy contents text", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephantomneedlephrase"},
{"name": "R4-F2 occupancy contents empty", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\"></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy contents whitespace", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\"> &#9; </span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy contents NBSP", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">&nbsp;</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy contents child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\"><div>phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phantomneedle phrase"},
{"name": "R4-F2 occupancy removed", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:none;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy ordinary inline width zero", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width zero", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic clipped width zero", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic width zero padded", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:8px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic empty positive width", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:20px\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy inline clipped height ignored", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;max-height:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic clipped height", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;max-height:0;overflow:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy visibility hidden inline", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy visibility visible child", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"visibility:hidden\"><b style=\"visibility:visible\">Shown</b></span><span id=\"after\">phrase</span>", "text": "VisibleShownphrase"},
{"name": "R4-F2 occupancy opacity visible child suppressed", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"visibility:visible;opacity:1\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy unknown wrapper attributes discarded", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><unknown style=\"display:block\">phantomneedle</unknown></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy only removed child", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b style=\"display:none\">phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy only hidden child", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0\"><b hidden>phantomneedle</b></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic only BR", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><br></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic empty child block", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><div></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic width zero padding zero conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;padding:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width zero min width conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;min-width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width zero color conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;color:red\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width reset auto", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:auto\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width reset initial", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:initial\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width reset unset", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:unset\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width reset positive", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:20px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy atomic width invalid retains zero", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:bogus\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic width important protects zero", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase"},
{"name": "R4-F2 occupancy atomic empty width important positive", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:20px!important\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy flex width zero conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-flex;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy grid width zero conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-grid;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy table width zero conservative", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-table;width:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visible phrase"},
{"name": "R4-F2 occupancy nested empty positive atomic child", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block\"><span style=\"display:inline-block;width:20px\"></span></span><span id=\"after\">phrase</span>", "text": "Visible phrase"}
);

visibleReviewCases.push(
{"name": "R4-F2 followup visible zero atomic suppressed block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;width:0\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 followup visible zero atomic suppressed block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;width:0\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 followup visible zero atomic suppressed block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block;width:0\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup visible natural atomic suppressed empty block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\"></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 followup visible natural atomic suppressed empty block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\"></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 followup visible natural atomic suppressed empty block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\"></div></span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup visible natural atomic suppressed text block visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 followup visible natural atomic suppressed text block visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 followup visible natural atomic suppressed text block phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:inline-block\"><div style=\"opacity:0\">phantomneedle</div></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup atomic width function invalidates zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:calc(20px)\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 followup atomic width function invalidates zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:calc(20px)\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 followup atomic width function invalidates zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:calc(20px)\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup atomic important zero protects from function visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:calc(20px)\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 followup atomic important zero protects from function visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:calc(20px)\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 followup atomic important zero protects from function phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:calc(20px)\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup atomic equal important reset positive visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px!important\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": true},
{"name": "R4-F2 followup atomic equal important reset positive visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px!important\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "visiblephrase", "query": "visiblephrase", "matches": false},
{"name": "R4-F2 followup atomic equal important reset positive phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0!important;width:20px!important\"></span><span id=\"after\">phrase</span>", "text": "Visible phrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup atomic escaped width zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;w\\69 dth:0p\\78\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 followup atomic escaped width zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;w\\69 dth:0p\\78\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 followup atomic escaped width zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;w\\69 dth:0p\\78\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 followup atomic negative width invalid retains zero visible phrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:-1px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visible phrase", "query": "\"visible phrase\"", "matches": false},
{"name": "R4-F2 followup atomic negative width invalid retains zero visiblephrase", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:-1px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "visiblephrase", "query": "visiblephrase", "matches": true},
{"name": "R4-F2 followup atomic negative width invalid retains zero phantomneedle", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"opacity:0;display:inline-block;width:0;width:-1px\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephrase", "value": "phantomneedle", "query": "phantomneedle", "matches": false},
{"name": "R4-F2 contents visible whole token positive", "html": "<span id=\"before\">Visible</span><span id=\"middle\" style=\"display:contents;opacity:0\">phantomneedle</span><span id=\"after\">phrase</span>", "text": "Visiblephantomneedlephrase", "value": "visiblephantomneedlephrase", "query": "visiblephantomneedlephrase", "matches": true}
);

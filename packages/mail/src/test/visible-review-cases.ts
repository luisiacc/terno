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
];

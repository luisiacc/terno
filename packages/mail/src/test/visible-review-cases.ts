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
];

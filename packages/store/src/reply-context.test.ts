import { expect, it } from "vitest";
import { replySubject } from "./reply-context";

it.each([
  ["  re: Re: Topic  ", "Topic"],
  [" Re: ", ""],
  ["Fwd: Topic", "Fwd: Topic"],
  ["AW: Topic", "AW: Topic"],
  ["Re[2]: Topic", "Re[2]: Topic"],
  ["Topic  One", "Topic  One"],
  ["topic", "topic"],
])("normalizes only reply prefixes: %j", (input, expected) => {
  expect(replySubject(input)).toBe(expected);
});

/** Plan 209: the entry still being typed isn't named before Send; what's committed and wrong still is, and Send stays strict. */
import { afterEach, describe, expect, it } from "vitest";
import { commit, derive, edit, EMPTY, firstInvalid, serialize, type FieldState } from "./recipient-field";
import { endTyping, setTyping, shownInvalid, typingOf, useRecipientTyping } from "./recipient-typing";

afterEach(() => useRecipientTyping.setState({}, true));

const draft = (toText: string, ccText = "", bccText = "") => ({ toText, ccText, bccText });
const typed = (s: FieldState) => ({ to: typingOf(s)! });

describe("what's said before Send (plan 209)", () => {
  it("leaves out the name still being typed after the chips", () => {
    const s: FieldState = { ...derive("ana@x.io, ", true), text: "isa" };
    const d = draft(serialize(s));
    expect(shownInvalid(d, typed(s))).toBeNull();
    // Send itself still refuses it (readiness and recipientProblem read firstInvalid)
    expect(firstInvalid(d.toText)).toBe("isa");
    // committed (a comma, Enter, Tab, blur), it's named
    const done = commit(s).state;
    expect(typingOf(done)).toBeNull();
    expect(shownInvalid(draft(serialize(done)), undefined)).toBe("isa");
  });

  it("still names a committed entry that isn't an address while another is typed", () => {
    const s: FieldState = { ...derive("bob@, ", true), text: "Arjun" };
    expect(shownInvalid(draft(serialize(s)), typed(s))).toBe("bob@");
  });

  it("counts a chip edited in the middle as typing, its place kept", () => {
    const field = derive("ana@x.io, isa, bob@y.io", false);
    const s = edit(field, field.chips[1]!.key);
    expect(s.at).toBe(1);
    const t = typingOf(s)!;
    expect(t).toEqual({ value: "ana@x.io, isa, bob@y.io", rest: "ana@x.io, bob@y.io" });
    expect(shownInvalid(draft(t.value), { to: t })).toBeNull();
  });

  it("checks the whole text when the note is for other text (changed from elsewhere since)", () => {
    const s: FieldState = { ...derive("ana@x.io, ", true), text: "isa" };
    expect(shownInvalid(draft("ana@x.io, isa, bob@"), typed(s))).toBe("isa");
  });

  it("is per field: typing in To leaves Cc's wrong entry named", () => {
    const s: FieldState = { ...EMPTY, text: "isa" };
    expect(shownInvalid(draft(serialize(s), "nope"), typed(s))).toBe("nope");
  });

  it("is kept per draft and field, and Send ends it", () => {
    const s: FieldState = { ...EMPTY, text: "isa" };
    setTyping("k", "to", typingOf(s));
    setTyping("k", "cc", typingOf(s));
    setTyping("other", "to", typingOf(s));
    setTyping("k", "to", null);
    expect(Object.keys(useRecipientTyping.getState().k!)).toEqual(["cc"]);
    endTyping("k");
    expect(useRecipientTyping.getState()).toEqual({ other: { to: typingOf(s) } });
  });
});


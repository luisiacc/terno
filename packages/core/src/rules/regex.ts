/**
 * Plan 84: the matcher behind the `matches` op. A filter runs on every
 * incoming message and over 50k old ones in the backend's event loop, so a
 * pattern must never backtrack: this is a Pike VM (Thompson's construction,
 * no captures) over the common subset of JavaScript's syntax. Its cost is
 * O(text × program), whatever the pattern. Case-insensitive, for text that
 * normalizeText already lower-cased.
 */

export type RegexIssue = "syntax" | "unsupported" | "complex";

/** A program holds at most this many instructions ({n,m} copies its atom). */
const PROGRAM_MAX = 2000;
/** The largest count a {n,m} may name. */
const REPEAT_MAX = 100;

type Test = (c: string) => boolean;
type Node =
  | { t: "char"; test: Test }
  | { t: "bol" }
  | { t: "eol" }
  | { t: "word"; not: boolean }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "repeat"; node: Node; min: number; max: number };

type Instr = { op: "char"; test: Test } | { op: "split"; x: number; y: number } | { op: "jmp"; x: number } | { op: "bol" } | { op: "eol" } | { op: "word"; not: boolean } | { op: "match" };

export class RegexError extends Error {
  constructor(readonly issue: RegexIssue) {
    super(issue);
  }
}

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isSpace = (c: string) => /\s/u.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
/** the text is lower-cased: a literal or range compares in either case */
const fold = (c: string) => c.toLowerCase();

const CLASS: Record<string, Test> = {
  d: isDigit,
  D: (c) => !isDigit(c),
  w: (c) => isWord(c),
  W: (c) => !isWord(c),
  s: isSpace,
  S: (c) => !isSpace(c),
};
const CONTROL: Record<string, string> = { t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", "0": "\0" };

class Parser {
  private i = 0;
  private readonly s: string[];
  constructor(source: string) {
    this.s = Array.from(source);
  }

  parse(): Node {
    const node = this.alt();
    if (this.i < this.s.length) throw new RegexError("syntax");
    return node;
  }

  private peek(at = 0): string | undefined {
    return this.s[this.i + at];
  }

  private alt(): Node {
    const options = [this.seq()];
    while (this.peek() === "|") {
      this.i++;
      options.push(this.seq());
    }
    return options.length === 1 ? options[0]! : { t: "alt", options };
  }

  private seq(): Node {
    const items: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== "|" && c !== ")"; c = this.peek()) {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { t: "seq", items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") [min, max] = [0, Infinity];
    else if (c === "+") [min, max] = [1, Infinity];
    else if (c === "?") [min, max] = [0, 1];
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i).join(""));
      if (!m) throw new RegexError("syntax");
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) throw new RegexError("syntax");
      if (min > REPEAT_MAX || (max !== Infinity && max > REPEAT_MAX)) throw new RegexError("complex");
      this.i += m[0].length - 1;
    } else return atom;
    this.i++;
    // a lazy mark changes which match, never whether one exists
    if (this.peek() === "?") this.i++;
    if (atom.t === "bol" || atom.t === "eol" || atom.t === "word") throw new RegexError("syntax");
    const next = this.peek();
    if (next === "*" || next === "+" || next === "?" || next === "{") throw new RegexError("syntax");
    return { t: "repeat", node: atom, min, max };
  }

  private atom(): Node {
    const c = this.s[this.i++]!;
    switch (c) {
      case "(": {
        if (this.peek() === "?") {
          const kind = this.peek(1);
          if (kind === ":") this.i += 2;
          else if (kind === "<" && this.peek(2) !== "=" && this.peek(2) !== "!") {
            // a named group: the name is only a label here
            const close = this.s.indexOf(">", this.i);
            if (close === -1 || !/^[A-Za-z_$][\w$]*$/.test(this.s.slice(this.i + 2, close).join(""))) throw new RegexError("syntax");
            this.i = close + 1;
          } else if (kind === "=" || kind === "!" || kind === "<") throw new RegexError("unsupported");
          else throw new RegexError("syntax");
        }
        const inner = this.alt();
        if (this.s[this.i++] !== ")") throw new RegexError("syntax");
        return inner;
      }
      case ")":
      case "*":
      case "+":
      case "?":
      case "{":
      case "}":
      case "]":
        throw new RegexError("syntax");
      case "[":
        return { t: "char", test: this.charClass() };
      case ".":
        return { t: "char", test: (x) => x !== "\n" && x !== "\r" && x !== " " && x !== " " };
      case "^":
        return { t: "bol" };
      case "$":
        return { t: "eol" };
      case "\\": {
        const e = this.s[this.i++];
        if (e === undefined) throw new RegexError("syntax");
        if (e === "b" || e === "B") return { t: "word", not: e === "B" };
        if (/[1-9]/.test(e) || e === "k") throw new RegexError("unsupported");
        if (CLASS[e]) return { t: "char", test: CLASS[e] };
        return literal(this.escaped(e));
      }
      default:
        return literal(c);
    }
  }

  /** An escape's character (after the backslash), outside or inside a class. */
  private escaped(e: string): string {
    if (CONTROL[e] !== undefined) {
      if (e === "0" && /[0-9]/.test(this.peek() ?? "")) throw new RegexError("unsupported");
      return CONTROL[e];
    }
    if (e === "x") {
      const hex = this.s.slice(this.i, this.i + 2).join("");
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new RegexError("syntax");
      this.i += 2;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (e === "u") {
      const rest = this.s.slice(this.i).join("");
      const m = /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(rest);
      const code = m ? parseInt(m[1] ?? m[2]!, 16) : NaN;
      if (!m || code > 0x10ffff) throw new RegexError("syntax");
      this.i += m[0].length;
      return String.fromCodePoint(code);
    }
    // under the u flag only syntax characters (and /, -) escape to themselves
    if (/[\^$\\.*+?()[\]{}|/-]/.test(e)) return e;
    throw new RegexError("syntax");
  }

  private charClass(): Test {
    const negate = this.peek() === "^";
    if (negate) this.i++;
    const tests: Test[] = [];
    let first = true;
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) throw new RegexError("syntax");
      if (c === "]" && !first) break;
      first = false;
      let lo: string;
      if (c === "\\") {
        const e = this.s[this.i++];
        if (e === undefined) throw new RegexError("syntax");
        if (CLASS[e]) {
          tests.push(CLASS[e]);
          continue;
        }
        if (e === "b") lo = "\b";
        else if (/[1-9]/.test(e) || e === "k") throw new RegexError("unsupported");
        else lo = this.escaped(e);
      } else if (c === "]") throw new RegexError("syntax");
      else lo = c;
      // a range: a-z (a trailing "-" is itself)
      if (this.peek() === "-" && this.peek(1) !== undefined && this.peek(1) !== "]") {
        this.i++;
        let hi = this.s[this.i++]!;
        if (hi === "\\") {
          const e = this.s[this.i++];
          if (e === undefined || CLASS[e]) throw new RegexError("syntax");
          hi = this.escaped(e);
        }
        const a = lo.codePointAt(0)!;
        const b = hi.codePointAt(0)!;
        if (a > b) throw new RegexError("syntax");
        tests.push((x) => {
          const inRange = (y: string) => {
            const p = y.codePointAt(0)!;
            return p >= a && p <= b;
          };
          return inRange(x) || inRange(x.toUpperCase()) || inRange(fold(x));
        });
        continue;
      }
      const want = fold(lo);
      tests.push((x) => fold(x) === want);
    }
    return negate ? (x) => !tests.some((t) => t(x)) : (x) => tests.some((t) => t(x));
  }
}

function literal(c: string): Node {
  const want = fold(c);
  return { t: "char", test: (x) => x === want || fold(x) === want };
}

function compile(node: Node): Instr[] {
  const prog: Instr[] = [];
  const emit = (i: Instr) => {
    if (prog.length >= PROGRAM_MAX) throw new RegexError("complex");
    prog.push(i);
    return prog.length - 1;
  };
  const gen = (n: Node): void => {
    switch (n.t) {
      case "char":
        emit({ op: "char", test: n.test });
        return;
      case "bol":
      case "eol":
        emit({ op: n.t });
        return;
      case "word":
        emit({ op: "word", not: n.not });
        return;
      case "seq":
        for (const item of n.items) gen(item);
        return;
      case "alt": {
        const jumps: number[] = [];
        for (let k = 0; k < n.options.length - 1; k++) {
          const split = emit({ op: "split", x: 0, y: 0 });
          (prog[split] as { x: number }).x = prog.length;
          gen(n.options[k]!);
          jumps.push(emit({ op: "jmp", x: 0 }));
          (prog[split] as { y: number }).y = prog.length;
        }
        gen(n.options[n.options.length - 1]!);
        for (const j of jumps) (prog[j] as { x: number }).x = prog.length;
        return;
      }
      case "repeat": {
        for (let k = 0; k < n.min; k++) gen(n.node);
        if (n.max === Infinity) {
          // L: split body, out; body; jmp L
          const split = emit({ op: "split", x: 0, y: 0 });
          (prog[split] as { x: number }).x = prog.length;
          gen(n.node);
          emit({ op: "jmp", x: split });
          (prog[split] as { y: number }).y = prog.length;
          return;
        }
        // each optional copy may stop the rest
        const outs: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          const split = emit({ op: "split", x: 0, y: 0 });
          (prog[split] as { x: number }).x = prog.length;
          outs.push(split);
          gen(n.node);
        }
        for (const s of outs) (prog[s] as { y: number }).y = prog.length;
        return;
      }
    }
  };
  gen(node);
  emit({ op: "match" });
  return prog;
}

export interface Regex {
  test(text: string): boolean;
}

/** Parses and compiles a pattern (accents already folded), or throws a RegexError. */
export function compileRegex(source: string): Regex {
  const prog = compile(new Parser(source).parse());
  // a pattern that starts with ^ (every branch) only ever starts at 0
  const anchored = prog[0]?.op === "bol";
  const n = prog.length;
  return {
    test(text: string): boolean {
      const chars = Array.from(text);
      let clist = new Int32Array(n);
      let nlist = new Int32Array(n);
      let ccount = 0;
      let ncount = 0;
      // the step each pc was last added in: one visit per step (an empty loop can't spin)
      const mark = new Int32Array(n).fill(-1);
      const stack: number[] = [];
      const add = (list: Int32Array, count: number, start: number, at: number, step: number): number => {
        stack.push(start);
        while (stack.length) {
          const pc = stack.pop()!;
          if (mark[pc] === step) continue;
          mark[pc] = step;
          const ins = prog[pc]!;
          switch (ins.op) {
            case "jmp":
              stack.push(ins.x);
              break;
            case "split":
              // y first onto the stack, so x is explored first (order only matters for which match, not whether)
              stack.push(ins.y, ins.x);
              break;
            case "bol":
              if (at === 0) stack.push(pc + 1);
              break;
            case "eol":
              if (at === chars.length) stack.push(pc + 1);
              break;
            case "word": {
              const boundary = isWord(chars[at - 1]) !== isWord(chars[at]);
              if (boundary !== ins.not) stack.push(pc + 1);
              break;
            }
            default:
              list[count++] = pc;
          }
        }
        return count;
      };
      let step = 0;
      ccount = add(clist, 0, 0, 0, step);
      for (let at = 0; ; at++) {
        for (let k = 0; k < ccount; k++) if (prog[clist[k]!]!.op === "match") return true;
        if (at >= chars.length) return false;
        step++;
        ncount = 0;
        const c = chars[at]!;
        for (let k = 0; k < ccount; k++) {
          const ins = prog[clist[k]!]!;
          if (ins.op === "char" && ins.test(c)) ncount = add(nlist, ncount, clist[k]! + 1, at + 1, step);
        }
        // unanchored: a match may also start at the next position
        if (!anchored) ncount = add(nlist, ncount, 0, at + 1, step);
        // anchored, nothing left alive can match; unanchored, a later start still may (an assertion can fail here only)
        if (ncount === 0 && anchored) return false;
        [clist, nlist] = [nlist, clist];
        ccount = ncount;
      }
    },
  };
}

#!/usr/bin/env python3
"""
What can be counted about a run of summaries-corpus.real.ts with no model in the loop. Reads ~/.terno-evals/runs/<run>.jsonl
against the corpus. Prints numbers only, never mail. A person or a judge still has to read for meaning.

  python3 -I scripts/ai-real/corpus/score.py <run> [<run> ...]
"""
import collections
import glob
import json
import pathlib
import re
import statistics
import sys
import unicodedata

HOME = pathlib.Path.home() / ".terno-evals"
SYNTHETIC = pathlib.Path(__file__).parent / "synthetic"
STOP = set("the a an of to and or in on at for from with by is are was be it this that your you i we they he she his her their our as if not no do does did has have had will would can could should may might please el la los las un una de del y o en con por para que se es son fue su sus tu te lo le les al como si".split())


def corpus() -> dict:
    rows = {}
    for path in [*sorted(SYNTHETIC.glob("*.jsonl")), *sorted(glob.glob(str(HOME / "real-mail" / "*.jsonl")))]:
        for line in open(path, encoding="utf-8"):
            if line.strip():
                row = json.loads(line)
                rows[row["id"]] = row
    return rows


def tokens(text: str) -> list:
    text = unicodedata.normalize("NFC", text).lower()
    return [w for w in re.findall(r"[\w$€£]+", text) if w not in STOP]


def overlap(row: str, summary: str) -> float:
    """How much of a row's content words the summary already holds."""
    words = tokens(row)
    if not words:
        return 0.0
    held = set(tokens(summary))
    return sum(w in held for w in words) / len(words)


NUMBER = re.compile(r"\d[\d,.]*\d|\d")
ENGLISH = set("the and is of to for that with this from you have are was".split())
SPANISH = set("el la los las de que y en para con por una un es del se".split())


def language_of(text: str) -> str:
    words = re.findall(r"[a-záéíóúñü]+", text.lower())
    en, es = sum(w in ENGLISH for w in words), sum(w in SPANISH for w in words)
    return "en" if en > es else "es" if es > en else "?"


def score(run: str, rows: dict) -> dict:
    # a run from before the corpus last changed can hold a conversation it no longer has
    results = [r for r in (json.loads(l) for l in open(HOME / "runs" / f"{run}.jsonl", encoding="utf-8") if l.strip()) if r["id"] in rows]
    groups = collections.defaultdict(list)
    for r in results:
        groups[r["set"]].append(r)
        groups["ALL"].append(r)
    out = {}
    for name, group in groups.items():
        ok = [r for r in group if "summary" in r]
        items = [i for r in ok for i in r["items"]]
        repeated = repeat_rows = own_questions = own_actions = invented = wrong_language = 0
        sentences = []
        for r in ok:
            row = rows[r["id"]]
            labels = {f"m{n + 1}": m for n, m in enumerate(row["messages"])}
            source = " ".join(m["text"] for m in row["messages"]) + " " + row["subject"]
            sentences.append(len(re.findall(r"[.!?…](\s|$)", r["summary"])) or 1)
            any_repeat = False
            for i in r["items"]:
                if overlap(i["text"], r["summary"]) >= 0.7 and len(tokens(i["text"])) >= 2:
                    any_repeat = True
                    repeat_rows += 1
                cited = labels.get(i["message"])
                if cited and cited["own"] and i["kind"] == "question":
                    own_questions += 1
                if cited and cited["own"] and i["kind"] == "action":
                    own_actions += 1
            repeated += any_repeat
            for n in NUMBER.findall(r["summary"] + " " + " ".join(i["text"] for i in r["items"])):
                bare = n.replace(",", "").replace(".", "")
                if len(bare) >= 2 and bare not in re.sub(r"[,.]", "", source):
                    invented += 1
            if len(r["summary"]) > 40 and language_of(r["summary"]) not in (r["language"], "?"):
                wrong_language += 1
        kinds = collections.Counter(i["kind"] for i in items)
        ms = [r["ms"] for r in ok]
        out[name] = {
            "n": len(group),
            "errors": len(group) - len(ok),
            "noRows%": round(100 * sum(not r["items"] for r in ok) / max(1, len(ok))),
            "rows/conv": round(len(items) / max(1, len(ok)), 2),
            "maxRows": max((len(r["items"]) for r in ok), default=0),
            "convWithRepeat%": round(100 * repeated / max(1, len(ok))),
            "repeatRows": repeat_rows,
            "ownQuestion": own_questions,
            "ownAction": own_actions,
            "unknownNumbers": invented,
            "wrongLang": wrong_language,
            "summaryChars": round(statistics.median(len(r["summary"]) for r in ok)) if ok else 0,
            "sentences": round(statistics.mean(sentences), 1) if ok else 0,
            "kinds": dict(kinds.most_common()),
            "p50s": round(statistics.median(ms) / 1000, 1) if ms else 0,
        }
    return out


def main() -> int:
    rows = corpus()
    for run in sys.argv[1:]:
        print(f"== {run}")
        for name, values in sorted(score(run, rows).items()):
            print(f"  {name:10} " + " ".join(f"{k}={v}" for k, v in values.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Checks a corpus file against README.md: the shape, and that nothing real slipped in. Exits 1 with what's wrong."""
import json
import re
import sys

REQUIRED = {"id", "author", "language", "category", "tags", "subject", "reader", "today", "messages", "truth"}
TRUTH = {"readerOwes", "othersOwe", "settled", "keyDates", "mustNotClaim"}
ADDRESS = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)")
LINK = re.compile(r"https?://([\w.-]+)")
KEYLIKE = re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|(?:\d[ -]?){15,16})\b")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def invented(host: str) -> bool:
    return host.endswith((".example", ".test", ".invalid")) or host == "example.com"


def check(row: dict) -> list[str]:
    missing = REQUIRED - row.keys()
    if missing:
        return [f"missing {sorted(missing)}"]
    errors = []
    if not row["messages"]:
        errors.append("no messages")
    if not DATE.match(str(row["today"])):
        errors.append("today isn't YYYY-MM-DD")
    if set(row["truth"]) != TRUTH:
        errors.append(f"truth must have exactly {sorted(TRUTH)}")
    elif not all(isinstance(v, list) and all(isinstance(s, str) for s in v) for v in row["truth"].values()):
        errors.append("truth's values must be lists of strings")
    dates = []
    for i, m in enumerate(row["messages"]):
        if not {"from", "date", "own", "text"} <= m.keys():
            errors.append(f"message {i} is missing a field")
            continue
        if not isinstance(m["own"], bool):
            errors.append(f"message {i}: own isn't true or false")
        if not DATE.match(str(m["date"])):
            errors.append(f"message {i}: date isn't YYYY-MM-DD")
        if not str(m["text"]).strip():
            errors.append(f"message {i}: no text")
        for field in ("to", "cc"):
            if field not in m:
                errors.append(f"message {i} has no {field}")
            elif not isinstance(m[field], list) or not all(isinstance(a, str) and a.strip() for a in m[field]):
                errors.append(f"message {i}: {field} isn't a list of strings")
        if isinstance(m.get("to"), list) and not m["to"]:
            errors.append(f"message {i}: nobody in to")
        if "list" in m and m["list"] is not True:
            errors.append(f"message {i}: list, when present, is true")
        dates.append(str(m["date"]))
    if dates != sorted(dates):
        errors.append("messages aren't oldest first")
    if dates and str(row["today"]) < dates[-1]:
        errors.append("today is before the last message")
    text = json.dumps(row, ensure_ascii=False)
    for host in ADDRESS.findall(text) + LINK.findall(text):
        if not invented(host.lower().rstrip(".")):
            errors.append(f"a real-looking host: {host}")
    if KEYLIKE.search(text):
        errors.append("something shaped like a key or a card number")
    return errors


def main() -> int:
    bad = 0
    seen = set()
    count = 0
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as e:
                    print(f"{path}:{n}: not JSON: {e}")
                    bad += 1
                    continue
                count += 1
                errors = check(row)
                if row.get("id") in seen:
                    errors.append("the id is used twice")
                seen.add(row.get("id"))
                for e in errors:
                    print(f"{path}:{n} ({row.get('id')}): {e}")
                bad += len(errors)
    print(f"{count} conversations, {bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Builds the real-mail corpus from public archives into ~/.terno-evals/real-mail/, outside the repo: these are real
people's words, and the repo is public. What's fetched is only ever parsed as data. The same inputs give the same
selection, since a thread is picked by a hash of its key, not at random.

  python3 -I scripts/ai-real/corpus/fetch-real.py [enron] [apache] [python-es] [debian-es]

Enron's tarball is 443 MB from https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz and goes in downloads/enron by
hand: that server is slow, and ranged parts are quicker. Everything else is fetched here and kept in downloads/, so a
second run reads no network.
"""
import collections
import datetime as dt
import email
import email.policy
import email.utils
import gzip
import hashlib
import html
import http.client
import json
import mailbox
import pathlib
import re
import sys
import tarfile
import time
import urllib.request

HOME = pathlib.Path.home() / ".terno-evals"
DOWNLOADS = HOME / "downloads"
OUT = HOME / "real-mail"
SEED = "terno-corpus-1"
MAX_TEXT = 12_000
USER_AGENT = "terno-eval-corpus/1 (research; one-off fetch of public list archives)"

APACHE_LISTS = [("dev", "httpd.apache.org"), ("users", "tomcat.apache.org"), ("users", "kafka.apache.org"), ("dev", "airflow.apache.org"), ("user", "spark.apache.org"), ("dev", "iceberg.apache.org"), ("user", "flink.apache.org")]
APACHE_MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
DEBIAN_MONTHS = [f"{y}/{m:02d}" for y in (2025, 2026) for m in range(1, 13) if (y, m) <= (2026, 10)]

ROBOT = re.compile(r"(no-?reply|notification|mailer-daemon|postmaster|jira@|github|bot@|builds?@|announce|digest)", re.I)
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")


def rank(key: str) -> str:
    return hashlib.sha1(f"{SEED}:{key}".encode()).hexdigest()


def fetch(url: str, path: pathlib.Path, pause: float = 0.25) -> pathlib.Path:
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
    except http.client.IncompleteRead as e:
        raise OSError(f"cut off after {len(e.partial)} bytes") from e
    path.write_bytes(data)
    time.sleep(pause)
    return path


def plain(message) -> str:
    """The text part, or the HTML one with its tags gone. An attachment's text isn't the mail's."""
    best = None
    for part in message.walk() if message.is_multipart() else [message]:
        if part.get_content_maintype() == "multipart" or part.get_filename():
            continue
        kind = part.get_content_type()
        if kind not in ("text/plain", "text/html"):
            continue
        try:
            raw = part.get_payload(decode=True) or b""
            text = raw.decode(part.get_content_charset() or "utf-8", "replace")
        except (LookupError, ValueError):
            text = str(part.get_payload())
        if kind == "text/html":
            text = strip_html(text)
        if kind == "text/plain":
            return text
        best = best or text
    return best or ""


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", text)
    return html.unescape(re.sub(r"<[^>]+>", "", text))


def tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("=20\n", "\n").replace("=\n", "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:MAX_TEXT]


def normal_subject(subject: str) -> str:
    previous = None
    s = (subject or "").strip()
    while s != previous:
        previous = s
        s = re.sub(r"(?i)^\s*(re|fw|fwd|rv|res|aw)\s*(\[\d+\])?\s*:\s*", "", s).strip()
        s = re.sub(r"^\s*\[[^\]]{1,40}\]\s*", "", s).strip()
    return re.sub(r"\s+", " ", s).lower()


def header(message, name: str) -> str:
    value = message.get(name, "")
    try:
        return str(email.header.make_header(email.header.decode_header(str(value))))
    except Exception:  # a broken header is common in old mail and says nothing about the rest
        return str(value)


def day(value: str):
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    return parsed.replace(tzinfo=None) if parsed else None


def conversation(source, cid, subject, reader, language, tags, messages):
    """`messages`: (datetime, from, own, text), any order. The next morning is `today`, as if just read."""
    ordered = sorted(messages, key=lambda m: m[0])
    last = ordered[-1][0]
    return {
        "id": cid,
        "source": source,
        "author": source,
        "language": language,
        "category": source,
        "tags": tags,
        "subject": subject,
        "reader": reader,
        "today": (last + dt.timedelta(days=1)).strftime("%Y-%m-%d"),
        "messages": [{"from": f, "date": d.strftime("%Y-%m-%d"), "own": own, "text": text} for d, f, own, text in ordered],
        "truth": {"readerOwes": [], "othersOwe": [], "settled": [], "keyDates": [], "mustNotClaim": []},
    }


def write(name: str, rows: list, notes: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.jsonl"
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest[name] = {"conversations": len(rows), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "seed": SEED, **notes}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{name}: {len(rows)} conversations -> {path}")


def buckets(threads: list, sizes: dict, per_owner: int = 2) -> list:
    """`threads`: (key, owner, messages). A deterministic spread across lengths, and not one person's whole mailbox."""
    picked = []
    for (low, high), want in sizes.items():
        owners = collections.Counter()
        for key, owner, messages in sorted((t for t in threads if low <= len(t[2]) <= high), key=lambda t: rank(t[0])):
            if len(picked) >= 10_000 or want == 0:
                break
            if owners[owner] >= per_owner:
                continue
            owners[owner] += 1
            picked.append((key, owner, messages))
            want -= 1
    return picked


def enron() -> None:
    archive = DOWNLOADS / "enron" / "enron_mail_20150507.tar.gz"
    keep = re.compile(r"^maildir/([^/]+)/(inbox|sent|sent_items|_sent_mail|notes_inbox|discussion_threads)(/|$)")
    boxes = collections.defaultdict(lambda: collections.defaultdict(dict))
    addresses = collections.defaultdict(collections.Counter)
    seen = 0
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            match = keep.match(member.name)
            if not match or not member.isfile():
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            message = email.message_from_bytes(handle.read())
            seen += 1
            user, folder = match.group(1), match.group(2)
            sent = folder.startswith(("sent", "_sent"))
            when = day(header(message, "Date"))
            sender = header(message, "From").strip()
            text = tidy(plain(message))
            if not when or not sender or not text or when.year < 1998 or when.year > 2003:
                continue
            if sent:
                addresses[user][sender.lower()] += 1
            recipients = len(re.findall(r"@", header(message, "To") + header(message, "Cc")))
            subject = header(message, "Subject")
            topic = normal_subject(subject)
            if not topic or recipients > 20 or ROBOT.search(sender) or SSN.search(text):
                continue
            # the same message sits in several folders
            boxes[user][topic][hashlib.sha1(f"{sender}|{when.date()}|{text[:400]}".encode()).hexdigest()] = (when, sender, sent, text, subject)
    threads = []
    for user, topics in boxes.items():
        mine = {a for a, n in addresses[user].items() if n >= 3}
        for topic, messages in topics.items():
            items = sorted(messages.values(), key=lambda m: m[0])
            if not any(m[1].lower() not in mine for m in items):
                continue
            # a subject reused a year apart isn't one conversation
            if (items[-1][0] - items[0][0]).days > 60 or len(items) > 12:
                continue
            threads.append((f"{user}/{topic}", user, [(w, s, s.lower() in mine, t, subj) for w, s, _, t, subj in items]))
    rows = []
    for key, user, messages in buckets(threads, {(1, 1): 50, (2, 4): 70, (5, 12): 40}):
        reader_addresses = sorted((a for a, n in addresses[user].items() if n >= 3), key=lambda a: -addresses[user][a])
        reader = {"name": user, "email": reader_addresses[0] if reader_addresses else f"{user}@enron.com"}
        tags = ["real", "own-last"] if messages[-1][2] else ["real"]
        rows.append(conversation("enron", f"enron-{rank(key)[:10]}", messages[0][4] or key, reader, "en", tags, [m[:4] for m in messages]))
    write("enron", rows, {"origin": "https://www.cs.cmu.edu/~enron/", "note": "Public via FERC; business mail, 1998 to 2002", "messagesRead": seen, "threadsFound": len(threads)})


def threads_of_mbox(path: pathlib.Path, source: str, language: str, tags: list, keep_year=None) -> list:
    box = mailbox.mbox(str(path), create=False)
    topics = collections.defaultdict(dict)
    for message in box:
        sender = re.sub(r"\s+via\s+\S+(?=\s*<)", "", header(message, "From")).strip()
        when = day(header(message, "Date"))
        subject = header(message, "Subject")
        topic = normal_subject(subject)
        text = tidy(plain(message))
        if not when or not topic or not text or ROBOT.search(sender) or (keep_year and when.year < keep_year):
            continue
        topics[topic][hashlib.sha1(f"{sender}|{when}|{text[:300]}".encode()).hexdigest()] = (when, sender, text, subject)
    out = []
    for topic, messages in topics.items():
        items = sorted(messages.values(), key=lambda m: m[0])
        if (items[-1][0] - items[0][0]).days <= 60 and len(items) <= 12:
            out.append((topic, source, items))
    return out


def list_rows(threads: list, source: str, language: str, sizes: dict, extra_tags: list) -> list:
    rows = []
    for key, _owner, items in buckets(threads, sizes, per_owner=10_000):
        # half read it as whoever started it, who is the one waiting for answers; half as a subscriber nobody asked
        starter = items[0][1]
        as_starter = int(rank(key + ":who")[:2], 16) % 2 == 0
        reader_from = starter if as_starter else "A subscriber <subscriber@list.invalid>"
        name, address = email.utils.parseaddr(reader_from)
        messages = [(w, s, s == reader_from, t) for w, s, t, _ in items]
        tags = ["real", "list", *extra_tags, "starter" if as_starter else "bystander"]
        if messages[-1][2]:
            tags.append("own-last")
        rows.append(conversation(source, f"{source}-{rank(key)[:10]}", items[0][3], {"name": name or address, "email": address}, language, tags, messages))
    return rows


def apache() -> None:
    threads = []
    for name, domain in APACHE_LISTS:
        for month in APACHE_MONTHS:
            path = DOWNLOADS / "apache" / f"{name}@{domain}-{month}.mbox"
            url = f"https://lists.apache.org/api/mbox.lua?list={name}&domain={domain}&d={month}"
            try:
                fetch(url, path)
            except OSError as e:
                print(f"skipped {path.name}: {e}")
                continue
            for key, _src, items in threads_of_mbox(path, "apache", "en", []):
                threads.append((f"{name}@{domain}/{key}", f"{name}@{domain}", items))
    rows = list_rows(threads, "apache", "en", {(1, 1): 15, (2, 4): 35, (5, 12): 30}, [])
    write("apache", rows, {"origin": "https://lists.apache.org/", "note": "Public developer and user lists, 2026", "threadsFound": len(threads)})


def python_es() -> None:
    # one year at a time: the server cuts a long export off part way
    threads = []
    for year in range(2014, 2027):
        url = f"https://mail.python.org/archives/list/python-es@python.org/export/python-es@python.org.mbox.gz?start={year}-01-01&end={year + 1}-01-01"
        try:
            gz = fetch(url, DOWNLOADS / "python-es" / f"{year}.mbox.gz")
        except OSError as e:
            print(f"skipped {year}: {e}")
            continue
        plain_path = gz.with_suffix("")
        if not plain_path.exists():
            plain_path.write_bytes(gzip.decompress(gz.read_bytes()))
        threads += [(f"{year}/{k}", "python-es", items) for k, _s, items in threads_of_mbox(plain_path, "python-es", "es", [])]
    rows = list_rows(threads, "python-es", "es", {(1, 1): 10, (2, 4): 25, (5, 12): 25}, ["spanish"])
    write("python-es", rows, {"origin": "https://mail.python.org/archives/list/python-es@python.org/", "note": "Public Spanish Python list, 2014 to 2026", "threadsFound": len(threads)})


def debian_es() -> None:
    topics = collections.defaultdict(dict)
    for month in DEBIAN_MONTHS:
        base = f"https://lists.debian.org/debian-user-spanish/{month}"
        folder = DOWNLOADS / "debian-es" / month.replace("/", "-")
        try:
            index = fetch(f"{base}/threads.html", folder / "threads.html").read_text("utf-8", "replace")
        except OSError as e:
            print(f"skipped {month}: {e}")
            continue
        for name in sorted(set(re.findall(r'href="(msg\d+\.html)"', index))):
            try:
                page = fetch(f"{base}/{name}", folder / name).read_text("utf-8", "replace")
            except OSError as e:
                print(f"skipped {month}/{name}: {e}")
                continue
            head = lambda field: html.unescape(re.sub(r"<[^>]+>", "", (re.search(rf"<li><em>{field}</em>:(.*?)</li>", page, re.S) or [None, ""])[1])).strip()
            body = re.search(r"<!--X-Body-of-Message-->(.*?)<!--X-Body-of-Message-End-->", page, re.S)
            sender, subject, when = head("From"), head("Subject"), day(head("Date"))
            text = tidy(strip_html(body.group(1))) if body else ""
            topic = normal_subject(subject)
            if when and topic and text and not ROBOT.search(sender):
                topics[topic][name + month] = (when, sender, text, subject)
    threads = []
    for topic, messages in topics.items():
        items = sorted(messages.values(), key=lambda m: m[0])
        if (items[-1][0] - items[0][0]).days <= 60 and len(items) <= 12:
            threads.append((topic, "debian-es", items))
    rows = list_rows(threads, "debian-es", "es", {(1, 1): 10, (2, 4): 25, (5, 12): 25}, ["spanish"])
    write("debian-es", rows, {"origin": "https://lists.debian.org/debian-user-spanish/", "note": "Public Spanish Debian list, 2025 to 2026", "threadsFound": len(threads)})


def main() -> int:
    sources = {"enron": enron, "apache": apache, "python-es": python_es, "debian-es": debian_es}
    chosen = sys.argv[1:] or list(sources)
    for name in chosen:
        started = time.time()
        sources[name]()
        print(f"  {name} took {time.time() - started:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Weekly stack check (AD-17). Flags only: it never changes a pin.

Diffs the pinned versions (package.json, ship.yml) against the latest releases, and the
vendor pricing/limits pages against the last snapshot. A new major released in the last
14 days is flagged as "too new to pin". Stdlib only.

  python3 tools/stack_check.py --dry-run   # print pinned vs latest and page changes; write nothing
  python3 tools/stack_check.py             # same, then save the page snapshot
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "tools" / ".stack-snapshot.json"
TOO_NEW_DAYS = 14
TIMEOUT = 20

# Free-tier pages whose change can break a $0 Project (STACK.md, "Free limits").
PRICING_PAGES = [
    "https://developers.cloudflare.com/workers/platform/limits/",
    "https://developers.cloudflare.com/workers/platform/pricing/",
    "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    "https://developers.cloudflare.com/ai-gateway/reference/pricing/",
    "https://neon.com/docs/introduction/plans",
    "https://console.groq.com/docs/rate-limits",
    "https://openrouter.ai/docs/api-reference/limits",
    "https://langfuse.com/pricing",
]

# GitHub releases behind the workflow pins.
ACTIONS = {
    "cloudflare/wrangler-action": r"cloudflare/wrangler-action@(v[\d.]+)",
    "anthropics/claude-code-action": r"anthropics/claude-code-action@(v[\d.]+)",
    "gitleaks/gitleaks": r"GITLEAKS_VERSION:\s*([\d.]+)",
}


def get(url: str, accept: str = "application/json") -> bytes:
    headers = {"accept": accept, "user-agent": "startup-project-template-stack-check"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=TIMEOUT) as r:
        return r.read()


def major(version: str) -> str:
    return version.lstrip("v").split(".")[0]


def pinned_npm() -> dict[str, str]:
    pkg = json.loads((ROOT / "package.json").read_text())
    return {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}


def pinned_actions() -> dict[str, str]:
    text = (ROOT / ".github" / "workflows" / "ship.yml").read_text()
    out = {}
    for repo, pattern in ACTIONS.items():
        m = re.search(pattern, text)
        if m:
            out[repo] = m.group(1)
    return out


def npm_latest(name: str) -> tuple[str, str | None]:
    """Latest version, and its release date when it is a new major (the full document is large)."""
    quoted = urllib.parse.quote(name, safe="@")
    latest = json.loads(get(f"https://registry.npmjs.org/{quoted}/latest"))["version"]
    return latest, None


def npm_release_date(name: str, version: str) -> str | None:
    quoted = urllib.parse.quote(name, safe="@")
    doc = json.loads(get(f"https://registry.npmjs.org/{quoted}"))
    return doc.get("time", {}).get(version)


def github_latest(repo: str) -> tuple[str, str | None]:
    rel = json.loads(get(f"https://api.github.com/repos/{repo}/releases/latest"))
    return rel["tag_name"], rel.get("published_at")


def days_since(iso: str | None, now: dt.datetime) -> int | None:
    if not iso:
        return None
    when = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (now - when).days


def compare(pinned: str, latest: str, released: str | None, now: dt.datetime) -> str | None:
    """A flag for one package, or None when the pin is current."""
    p, l = pinned.lstrip("v"), latest.lstrip("v")
    if p == l or (pinned.startswith("v") and pinned.count(".") == 0 and major(p) == major(l)):
        return None  # exact match, or a floating major tag (v1) that still covers latest
    if major(p) != major(l):
        age = days_since(released, now)
        if age is not None and age < TOO_NEW_DAYS:
            return f"new major {latest} is {age} day(s) old: too new to pin (AD-17 rule 6)"
        return f"new major {latest} (pinned {pinned}): review before moving"
    return f"newer {latest} (pinned {pinned})"


def page_fingerprint(url: str) -> str:
    raw = get(url, accept="text/html").decode("utf-8", "replace")
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    text = re.sub(r"\s+", " ", text).strip()
    return hashlib.sha256(text.encode()).hexdigest()


def run(dry_run: bool, offline_pages: bool = False) -> list[str]:
    now = dt.datetime.now(dt.timezone.utc)
    flags: list[str] = []
    print(f"stack check {now:%Y-%m-%d %H:%M}Z{' (dry run)' if dry_run else ''}\n")
    print(f"{'package':40} {'pinned':16} {'latest':16} flag")
    for name, pinned in sorted(pinned_npm().items()):
        try:
            latest, _ = npm_latest(name)
            released = npm_release_date(name, latest) if major(latest) != major(pinned) else None
            flag = compare(pinned, latest, released, now)
        except Exception as exc:  # network trouble is a flag, not a crash
            latest, flag = "?", f"lookup failed: {exc}"
        print(f"{name:40} {pinned:16} {latest:16} {flag or ''}")
        if flag:
            flags.append(f"{name}: {flag}")
    for repo, pinned in sorted(pinned_actions().items()):
        try:
            latest, released = github_latest(repo)
            flag = compare(pinned, latest, released, now)
        except Exception as exc:
            latest, flag = "?", f"lookup failed: {exc}"
        print(f"{repo:40} {pinned:16} {latest:16} {flag or ''}")
        if flag:
            flags.append(f"{repo}: {flag}")

    if not offline_pages:
        old = json.loads(SNAPSHOT.read_text()) if SNAPSHOT.exists() else {}
        new: dict[str, str] = {}
        print("\npricing and limits pages")
        for url in PRICING_PAGES:
            try:
                new[url] = page_fingerprint(url)
            except Exception as exc:
                flags.append(f"{url}: fetch failed: {exc}")
                print(f"  fetch failed  {url}")
                continue
            if url not in old:
                state = "first snapshot"
            elif old[url] != new[url]:
                state = "CHANGED"
                flags.append(f"{url}: page changed since the last check, re-read its free limits")
            else:
                state = "unchanged"
            print(f"  {state:14} {url}")
        if not dry_run:
            SNAPSHOT.write_text(json.dumps({**old, **new}, indent=2) + "\n")

    print(f"\n{len(flags)} flag(s)")
    for f in flags:
        print(f"  - {f}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("## Stack check\n\n" + ("\n".join(f"- {f}" for f in flags) or "No changes.") + "\n")
    return flags


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print only; do not save the page snapshot")
    ap.add_argument("--no-pages", action="store_true", help="skip the pricing pages")
    args = ap.parse_args()
    run(args.dry_run, offline_pages=args.no_pages)
    return 0  # flags only: never fails the job


if __name__ == "__main__":
    sys.exit(main())

"""Regenerate the dashboard's vendored copy of the Public Suffix List.

Usage:
    python scripts/build_public_suffix_list.py               # fetch and write
    python scripts/build_public_suffix_list.py --input x.dat # from a local file
    python scripts/build_public_suffix_list.py --check       # fail if stale

The dashboard needs to know whether a domain like ``co.uk`` is a public suffix
rather than something a person can register. Rule consolidation offers to
replace several exact Website rules with one rule for their shared parent, and
without this list the parent of ``bbc.co.uk`` and ``guardian.co.uk`` computes as
``co.uk`` — one accepted suggestion away from classifying every future UK site.

This runs by hand, not from the build. A network fetch inside the build would
make it non-reproducible and would fail offline, and the list changes slowly
enough that refreshing it once per release is enough.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = "https://publicsuffix.org/list/public_suffix_list.dat"

DEFAULT_OUTPUT = (
    Path(__file__).resolve().parent.parent
    / "dashboard"
    / "src"
    / "lib"
    / "publicSuffixData.ts"
)

# The rules are emitted inside a TypeScript template literal. None of these may
# appear in a rule, and a list that grew one would silently produce a module
# that does not parse — or worse, one that parses as something else.
FORBIDDEN = ("`", "\\", "${")


def parse_rules(text: str) -> list[str]:
    """Rules only, in source order.

    Comment lines start with ``//`` — including the ``===BEGIN ICANN DOMAINS===``
    markers, which is why the sections need no special handling here. Both
    sections are kept: ICANN carries the ccTLDs that make this worth having, and
    PRIVATE carries the shared hosts (``github.io``, ``vercel.app``) whose
    subdomains belong to unrelated people.

    Rules are lowercased. The list is already lowercase throughout, but a
    matcher that lowercases its input has to be able to trust that.
    """
    rules: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        rules.append(line.lower())
    return rules


def render_module(rules: list[str], *, source_url: str = SOURCE_URL) -> str:
    """The generated TypeScript module, as text."""
    for rule in rules:
        for bad in FORBIDDEN:
            if bad in rule:
                raise ValueError(f"rule {rule!r} contains {bad!r}, which cannot be emitted")
    if not rules:
        raise ValueError("refusing to emit an empty list")
    script = Path(__file__).name
    body = "\n".join(rules)
    return (
        "// Generated file — do not edit.\n"
        f"// Source: {source_url}\n"
        f"// Regenerate: python scripts/{script}\n"
        "//\n"
        "// One rule per line, in source order. See publicSuffix.ts for what the\n"
        "// leading `!` and the `*` labels mean.\n"
        "export const PUBLIC_SUFFIX_RULES = `\n"
        f"{body}\n"
        "`;\n"
    )


def fetch(url: str = SOURCE_URL) -> str:
    with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 - fixed https URL
        return response.read().decode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="read the .dat from a file instead of fetching")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--url", default=SOURCE_URL)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the output is missing or out of date, writing nothing",
    )
    args = parser.parse_args(argv)

    text = args.input.read_text(encoding="utf-8") if args.input else fetch(args.url)
    rules = parse_rules(text)
    module = render_module(rules, source_url=args.url)

    if args.check:
        current = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if current == module:
            print(f"{args.output} is up to date ({len(rules)} rules)")
            return 0
        print(f"{args.output} is out of date — rerun without --check", file=sys.stderr)
        return 1

    args.output.write_text(module, encoding="utf-8", newline="\n")
    print(f"wrote {args.output} ({len(rules)} rules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

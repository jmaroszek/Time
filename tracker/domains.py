"""Extract a domain from a browser window title.

Supports two shapes produced by "URL in title" browser extensions, tried in order:
  1. A full URL anywhere in the title:        "Page - https://example.com/path"
  2. A bare domain after a separator at the
     end of the title (browser suffix like
     " - Google Chrome" is stripped first):   "Page • example.com"

Titles without either shape return None.
"""

from __future__ import annotations

import re

_URL_RE = re.compile(r"https?://([^/\s]+)", re.IGNORECASE)
_BROWSER_SUFFIX_RE = re.compile(
    r"\s+[-–—]\s+(google chrome|thorium|microsoft edge|brave|mozilla firefox|firefox)$",
    re.IGNORECASE,
)
_TRAILING_DOMAIN_RE = re.compile(
    r"[•·|\-–—]\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$", re.IGNORECASE
)


def _clean_host(host: str) -> str | None:
    host = host.lower().strip().strip(".")
    host = host.split(":")[0]  # drop port
    host = host.removeprefix("www.")
    return host or None


def parse_domain(title: str) -> str | None:
    if not title:
        return None
    m = _URL_RE.search(title)
    if m:
        return _clean_host(m.group(1))
    stripped = _BROWSER_SUFFIX_RE.sub("", title.strip())
    m = _TRAILING_DOMAIN_RE.search(stripped)
    if m:
        return _clean_host(m.group(1))
    return None

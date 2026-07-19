"""Extract a domain from a browser window title.

Supports two shapes produced by "URL in title" browser extensions, tried in order:
  1. A full URL anywhere in the title:        "Page - https://example.com/path"
  2. A bare domain after a separator at the
     end of the title (browser suffix like
     " - Google Chrome" is stripped first):   "Page • example.com"

Titles without either shape return None.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_BROWSER_SUFFIX_RE = re.compile(
    r"\s+[-–—]\s+(google chrome|thorium|microsoft edge|brave|mozilla firefox|firefox)$",
    re.IGNORECASE,
)
_TRAILING_DOMAIN_RE = re.compile(
    r"[•·|\-–—]\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$", re.IGNORECASE
)
_HOST_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_URL_TRAILING_PUNCTUATION = ").,;!?]}>"


def _clean_host(host: str) -> str | None:
    host = host.lower().strip().rstrip(".")
    host = host.removeprefix("www.")
    if not host or len(host) > 253:
        return None
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if host == "localhost":
        return host
    labels = host.split(".")
    if len(labels) < 2 or all(label.isdigit() for label in labels):
        return None
    if any(_HOST_LABEL_RE.fullmatch(label) is None for label in labels):
        return None
    return host


def parse_domain(title: str) -> str | None:
    if not title:
        return None
    m = _URL_RE.search(title)
    if m:
        try:
            host = urlsplit(m.group(0).rstrip(_URL_TRAILING_PUNCTUATION)).hostname
        except ValueError:
            host = None
        if host:
            return _clean_host(host)
    stripped = _BROWSER_SUFFIX_RE.sub("", title.strip())
    m = _TRAILING_DOMAIN_RE.search(stripped)
    if m:
        return _clean_host(m.group(1))
    return None

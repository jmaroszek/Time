"""Derive privacy-safe browser fields from the foreground window title.

The first-party extension writes one terminal ``TIME_URL_V1`` marker. Its
strict parser runs before the retained legacy URL-title heuristics so malformed
or unknown Time markers cannot be interpreted piecemeal. Only the normalized
host and the sanitized page title leave this module; the reduced URL is kept
only long enough to derive that host.
"""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re
from urllib.parse import SplitResult, urlsplit

_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_ANY_URL_RE = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.IGNORECASE)
_BROWSER_SUFFIX_RE = re.compile(
    r"\s+[-–—]\s+(google chrome|thorium|microsoft edge|brave|mozilla firefox|firefox)$",
    re.IGNORECASE,
)
_TRAILING_DOMAIN_RE = re.compile(
    r"[•·|\-–—]\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$", re.IGNORECASE
)
_HOST_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_URL_TRAILING_PUNCTUATION = ").,;!?]}>"

_TIME_MARKER_PREFIX = "[[TIME_URL_"
_TIME_V1_PREFIX = "[[TIME_URL_V1:"
_TIME_MARKER_SUFFIX = "]]"
_TIME_V1_MAX_CANDIDATE_LENGTH = 8_192


@dataclass(frozen=True)
class ParsedBrowserTitle:
    marker_version: int | None
    original_title: str
    reduced_url: str | None


@dataclass(frozen=True)
class BrowserPrivacyFields:
    """The only browser-title values allowed beyond the parsing boundary."""

    title: str
    domain: str | None


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


def _split_reduced_url(candidate: str) -> SplitResult | None:
    if (
        not candidate
        or len(candidate) > _TIME_V1_MAX_CANDIDATE_LENGTH
        or "?" in candidate
        or "#" in candidate
        or any(character.isspace() or ord(character) < 0x20 for character in candidate)
    ):
        return None

    try:
        parsed = urlsplit(candidate)
        # Accessing these properties forces validation of malformed bracketed
        # hosts and ports, which urlsplit otherwise defers.
        host = parsed.hostname
        _ = parsed.port
    except (TypeError, ValueError):
        return None

    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return None
    return parsed


def _parse_browser_title(
    title: str,
) -> tuple[ParsedBrowserTitle, SplitResult | None]:
    ordinary = ParsedBrowserTitle(None, title, None)
    if not title.endswith(_TIME_MARKER_SUFFIX):
        return ordinary, None

    marker_start = title.rfind(_TIME_V1_PREFIX)
    if marker_start < 0:
        return ordinary, None
    candidate = title[
        marker_start + len(_TIME_V1_PREFIX) : -len(_TIME_MARKER_SUFFIX)
    ]
    reduced = _split_reduced_url(candidate)
    if reduced is None:
        return ordinary, None

    separator_length = 1 if marker_start > 0 and title[marker_start - 1] == " " else 0
    return (
        ParsedBrowserTitle(
            1,
            title[: marker_start - separator_length],
            candidate,
        ),
        reduced,
    )


def parse_browser_title(title: str) -> ParsedBrowserTitle:
    """Parse one valid terminal V1 marker without throwing.

    Invalid, non-terminal, or unknown markers are ordinary title text. The
    parser removes only the extension-owned separator immediately before a
    valid suffix and otherwise preserves the page-authored title exactly.
    """
    parsed, _ = _parse_browser_title(title)
    return parsed


def _parse_legacy_domain(title: str) -> str | None:
    if not title:
        return None
    match = _URL_RE.search(title)
    if match:
        try:
            host = urlsplit(
                match.group(0).rstrip(_URL_TRAILING_PUNCTUATION)
            ).hostname
        except ValueError:
            host = None
        if host:
            return _clean_host(host)
    stripped = _BROWSER_SUFFIX_RE.sub("", title.strip())
    match = _TRAILING_DOMAIN_RE.search(stripped)
    if match:
        return _clean_host(match.group(1))
    return None


def _sanitize_legacy_browser_title(title: str) -> str:
    cleaned = _BROWSER_SUFFIX_RE.sub("", title.replace("\x00", "").strip())
    cleaned = _ANY_URL_RE.sub("", cleaned)
    cleaned = _TRAILING_DOMAIN_RE.sub("", cleaned)
    cleaned = re.sub(r"(?:\s*[-–—•·|]\s*)+$", "", cleaned)
    cleaned = re.sub(r"^(?:\s*[-–—•·|]\s*)+", "", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()[:512]


def _sanitize_ordinary_title(title: str) -> str:
    """Apply only the general title boundary to reserved marker-like text."""
    return title.replace("\x00", "")[:512]


def browser_privacy_fields(title: str) -> BrowserPrivacyFields:
    """Return a sanitized title and normalized domain from one parse result.

    A recognized marker is authoritative. Reserved marker-like input that does
    not pass strict V1 validation is not handed to the legacy URL regexes; this
    is the fail-closed boundary that prevents malformed marker syntax and its
    embedded candidate from producing a domain or a partly stripped title.
    """
    parsed, reduced = _parse_browser_title(title)
    if parsed.reduced_url is not None:
        domain = _clean_host(reduced.hostname) if reduced and reduced.hostname else None
        return BrowserPrivacyFields(
            _sanitize_legacy_browser_title(parsed.original_title),
            domain,
        )

    if _TIME_MARKER_PREFIX in title:
        return BrowserPrivacyFields(_sanitize_ordinary_title(title), None)
    return BrowserPrivacyFields(
        _sanitize_legacy_browser_title(title),
        _parse_legacy_domain(title),
    )


def parse_domain(title: str) -> str | None:
    """Return the V1 or legacy normalized domain for compatibility callers."""
    return browser_privacy_fields(title).domain


def sanitize_browser_title(title: str) -> str:
    """Return the title paired with ``parse_domain`` by the same parse pass."""
    return browser_privacy_fields(title).title

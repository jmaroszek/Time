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
# Browser product names as they appear in window titles. Whitespace inside a
# name is flexible because Edge renders "Microsoft  Edge" with a wider gap than
# one space. Keep aligned with DEFAULT_BROWSER_PROCESSES in tracker/db.py and
# browsers.ts: a browser in that list without an entry here gets no chrome
# stripped, so a terminal marker behind its name never parses.
_BROWSER_SUFFIX_RE = re.compile(
    r"\s+[-–—]\s+("
    r"google\s+chrome|thorium|microsoft\s+edge|brave|mozilla\s+firefox|firefox"
    r"|opera(?:\s+gx)?|vivaldi"
    r")$",
    re.IGNORECASE,
)
# Edge renders its own name as "Microsoft​ Edge" in the window title, so a
# literal match on the product name fails against the title the tracker samples
# even though the name looks right on screen. Removed before any window-chrome
# match rather than added to the alternation above, which would have to carry a
# variant per browser per invisible character.
_ZERO_WIDTH_RE = re.compile(r"[​‌‍﻿]")
# Edge appends its tab count after the page title when more than one tab is
# open, which pushes a terminal marker into the middle of the window title.
_TAB_COUNT_RE = re.compile(r"\s+and\s+\d+\s+more\s+pages?$", re.IGNORECASE)
# Chromium browsers append the signed-in profile's label ("- Personal") between
# the page title and their own name. Bounded and dash-delimited because this runs
# against what is left of a page-authored title.
_PROFILE_LABEL_RE = re.compile(r"\s+[-–—]\s+[^-–—]{1,64}$")
_MAX_CHROME_DECORATIONS = 3
_TRAILING_DOMAIN_RE = re.compile(
    r"[•·|\-–—]\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s*$", re.IGNORECASE
)
_HOST_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_URL_TRAILING_PUNCTUATION = ").,;!?]}>"

# The version token trails the reduced URL so a truncated browser tab shows the
# site rather than the marker's own name. The sentinel stays deliberately loose
# so any marker-like text fails closed instead of reaching the legacy heuristics.
_TIME_MARKER_SENTINEL = "TIME_URL_V"
_TIME_MARKER_OPEN = "[["
_TIME_V1_SUFFIX = ":TIME_URL_V1]]"
_TIME_V1_MAX_CANDIDATE_LENGTH = 8_192
_ORPHAN_MARKER_OPEN_RE = re.compile(r"\s*\[\[\s*$")
# One complete marker span of any version, used only to strip a marker Time
# declined to validate. Nested brackets are excluded so this cannot run past the
# span it matched.
_MARKER_SPAN_RE = re.compile(
    r"\s*\[\[[^\[\]]*" + _TIME_MARKER_SENTINEL + r"[^\[\]]*\]\]",
    re.IGNORECASE,
)


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


def normalize_host(raw: str) -> str | None:
    """Normalize a hand-typed or pasted site into the host sessions store.

    Settings fields are where people type "YouTube.com", "www.netflix.com/browse"
    or a whole copied URL, and a media site that does not survive that typing
    matches nothing at all. Everything a browser would ignore when resolving the
    host is dropped here, and the result goes through the same `_clean_host`
    that domains derived from a window title do, so a stored entry can only ever
    be a host a session could also carry.
    """
    candidate = raw.strip()
    if not candidate:
        return None
    if "://" in candidate:
        candidate = candidate.split("://", 1)[1]
    for separator in ("/", "?", "#"):
        candidate = candidate.split(separator, 1)[0]
    # Userinfo before the port: "user:pass@host" holds a colon of its own.
    candidate = candidate.rsplit("@", 1)[-1]
    candidate = candidate.split(":", 1)[0]
    return _clean_host(candidate)


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


def _parse_terminal_marker(
    title: str,
) -> tuple[ParsedBrowserTitle, SplitResult | None] | None:
    """Parse one marker that ends ``title``, or return None if there is none."""
    if not title.endswith(_TIME_V1_SUFFIX):
        return None

    # "[[" alone is not distinctive, so a page-authored title or a pathname may
    # contain it. Walk candidate openings right to left and let strict candidate
    # validation decide; widening candidates can only get longer, so an
    # over-length candidate ends the search.
    candidate_end = len(title) - len(_TIME_V1_SUFFIX)
    search_from = candidate_end

    while True:
        marker_start = title.rfind(_TIME_MARKER_OPEN, 0, search_from)
        if marker_start < 0:
            return None

        candidate = title[marker_start + len(_TIME_MARKER_OPEN) : candidate_end]
        if len(candidate) > _TIME_V1_MAX_CANDIDATE_LENGTH:
            return None

        reduced = _split_reduced_url(candidate)
        if reduced is not None:
            separator_length = (
                1 if marker_start > 0 and title[marker_start - 1] == " " else 0
            )
            return (
                ParsedBrowserTitle(
                    1,
                    title[: marker_start - separator_length],
                    candidate,
                ),
                reduced,
            )

        search_from = marker_start


def _strip_one_decoration(candidate: str) -> str | None:
    """Remove one decoration a browser puts before its own name, if present."""
    without_tab_count = _TAB_COUNT_RE.sub("", candidate)
    if without_tab_count != candidate:
        return without_tab_count

    match = _PROFILE_LABEL_RE.search(candidate)
    if match is None:
        return None
    # A segment carrying a URL or a bracket run is page-authored title text, not
    # a profile label. Refusing those keeps this from consuming the very marker
    # it is trying to expose, which is also what stops a page from getting a
    # mid-title marker of its own accepted by inventing a trailing segment.
    removed = match.group(0)
    if "://" in removed or _TIME_MARKER_OPEN in removed:
        return None
    return candidate[: match.start()]


def _browser_chrome_candidates(title: str) -> list[str]:
    """Return the title with one browser's own window decorations removed.

    Matching a known browser name before stripping anything else is what keeps
    this safe: a page-authored title that merely ends in " - Chapter 2" is never
    touched, because nothing identified it as a browser's own chrome. Each strip
    is a separate candidate, and the caller keeps the original title when none of
    them yields a valid marker, so widening what counts as chrome cannot change
    an ordinary title.
    """
    candidate = _ZERO_WIDTH_RE.sub("", title)
    without_name = _BROWSER_SUFFIX_RE.sub("", candidate)
    if without_name == candidate:
        return []

    candidates = [without_name]
    current = without_name
    for _ in range(_MAX_CHROME_DECORATIONS):
        stripped = _strip_one_decoration(current)
        if stripped is None:
            break
        candidates.append(stripped)
        current = stripped
    return candidates


def _parse_browser_title(
    title: str,
) -> tuple[ParsedBrowserTitle, SplitResult | None]:
    parsed = _parse_terminal_marker(title)
    if parsed is not None:
        return parsed

    # The extension writes a terminal marker to ``document.title``, but the
    # window title the tracker samples is what the browser renders around it --
    # Chrome appends " - Google Chrome", Edge "​ - Microsoft Edge" plus a tab
    # count. The marker is therefore terminal in the page and non-terminal on
    # the desktop, so retry against the title with that chrome removed. A title
    # with no valid marker after every retry is returned untouched, so widening
    # what counts as chrome cannot alter an ordinary title.
    for candidate in _browser_chrome_candidates(title):
        parsed = _parse_terminal_marker(candidate)
        if parsed is not None:
            return parsed

    return ParsedBrowserTitle(None, title, None), None


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
    cleaned = _BROWSER_SUFFIX_RE.sub(
        "", _ZERO_WIDTH_RE.sub("", title.replace("\x00", "")).strip()
    )
    without_url = _ANY_URL_RE.sub("", cleaned)
    if without_url != cleaned:
        # A window title truncated inside the marker loses the
        # ":TIME_URL_V1]]" tail, so the strict parser cannot claim it and the
        # URL strip above leaves the marker's own "[[" behind. Drop that orphan
        # instead of storing it as page-authored text.
        without_url = _ORPHAN_MARKER_OPEN_RE.sub("", without_url)
    cleaned = without_url
    cleaned = _TRAILING_DOMAIN_RE.sub("", cleaned)
    cleaned = re.sub(r"(?:\s*[-–—•·|]\s*)+$", "", cleaned)
    cleaned = re.sub(r"^(?:\s*[-–—•·|]\s*)+", "", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()[:512]


def _sanitize_reserved_marker_title(title: str) -> str:
    """Remove marker syntax and URLs from a title Time refused to parse.

    The domain still fails closed: an unvalidated marker never yields one. The
    title cannot also be kept verbatim, though, because the text Time declined
    to parse is a URL that Time's own endorsed extension put there. With title
    capture enabled that persisted whole URLs -- including the query strings the
    validated path rejects the marker for carrying in the first place.

    Whole marker spans go first so a malformed candidate leaves no husk behind,
    then any remaining URL run, so what is removed does not depend on which part
    of the grammar was malformed.
    """
    cleaned = _MARKER_SPAN_RE.sub("", title.replace("\x00", ""))
    cleaned = _ANY_URL_RE.sub("", cleaned)
    cleaned = _ORPHAN_MARKER_OPEN_RE.sub("", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()[:512]


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

    if _TIME_MARKER_SENTINEL in title:
        return BrowserPrivacyFields(_sanitize_reserved_marker_title(title), None)
    return BrowserPrivacyFields(
        _sanitize_legacy_browser_title(title),
        _parse_legacy_domain(title),
    )


def parse_domain(title: str) -> str | None:
    """Return the V1 or legacy normalized domain for compatibility callers."""
    return browser_privacy_fields(title).domain

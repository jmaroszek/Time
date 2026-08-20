import ipaddress
import json
from pathlib import Path
import random
import re
import string

import pytest

from tracker.domains import (
    browser_privacy_fields,
    normalize_host,
    parse_browser_title,
    parse_domain,
)


PROTOCOL_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "browser_title_protocol.json").read_text(
        encoding="utf-8"
    )
)


def test_full_url_in_title():
    assert parse_domain("My Video - https://www.youtube.com/watch?v=abc - Google Chrome") == "youtube.com"


def test_url_with_port():
    assert parse_domain("App - http://localhost:5173/dash") == "localhost"


def test_trailing_domain_after_bullet():
    assert parse_domain("Rick and Morty • xprime.tv") == "xprime.tv"


def test_trailing_domain_after_dash_with_browser_suffix():
    assert parse_domain("Front page - reddit.com - Google Chrome") == "reddit.com"


def test_plain_chrome_title_has_no_domain():
    assert parse_domain("How Buddha Humbled Sun Wukong - YouTube - Google Chrome") is None


def test_plain_title_no_domain():
    assert parse_domain("Skill Tree (Sandbox) - Google Chrome") is None


def test_filename_like_title_not_mistaken_for_domain():
    assert parse_domain("tracker.py at main · repo · GitHub - Google Chrome") is None


def test_empty_title():
    assert parse_domain("") is None


def test_browser_title_strips_url_and_browser_suffix():
    assert browser_privacy_fields(
        "Account - https://user:secret@example.com/private?q=token - Google Chrome"
    ).title == "Account"


def test_browser_title_strips_non_http_url_schemes():
    assert browser_privacy_fields("Local file - file:///C:/Users/person/private.txt").title == "Local file"


def test_browser_title_strips_trailing_domain():
    assert browser_privacy_fields("Front page - reddit.com - Mozilla Firefox").title == "Front page"


def test_browser_title_preserves_non_url_page_name():
    assert browser_privacy_fields("Project notes - Google Chrome").title == "Project notes"


def test_www_prefix_stripped():
    assert parse_domain("News • www.example.co.uk") == "example.co.uk"


def test_url_userinfo_and_port_do_not_replace_the_host():
    assert parse_domain("Admin - https://user:secret@www.example.com:8443/path") == "example.com"


def test_ipv6_url_is_supported():
    assert parse_domain("Local - http://[::1]:5173/dash") == "::1"


def test_invalid_host_labels_are_rejected():
    assert parse_domain("Page - https://-bad.example/path") is None
    assert parse_domain("Page - https://999.999.999.999/path") is None
    assert parse_domain("Page • bad-.example") is None


def test_seeded_fuzz_preserves_valid_decorated_urls():
    """Property-style fuzzing without adding a runtime/test dependency."""
    rng = random.Random(20260719)
    alphabet = string.ascii_lowercase + string.digits
    for _ in range(1_000):
        labels = []
        for _part in range(rng.randint(2, 4)):
            middle = "".join(rng.choice(alphabet + "-") for _ in range(rng.randint(0, 12)))
            labels.append(rng.choice(alphabet) + middle + rng.choice(alphabet))
        host = ".".join(labels)
        auth = "user:secret@" if rng.random() < 0.25 else ""
        prefix = "www." if rng.random() < 0.5 else ""
        port = f":{rng.randint(1, 65535)}" if rng.random() < 0.4 else ""
        punctuation = rng.choice(["", ")", ".", ","])
        title = f"{rng.choice(['Page', 'Docs', 'Video'])} - https://{auth}{prefix}{host}{port}/p?q=1{punctuation}"
        assert parse_domain(title) == host


def test_seeded_hostile_title_fuzz_never_raises_or_returns_malformed_hosts():
    rng = random.Random(20260720)
    alphabet = string.printable + "•–—例子\x00"
    label_re = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    for _ in range(2_000):
        title = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 300)))
        result = parse_domain(title)
        if result is None:
            continue
        assert result == result.lower()
        assert not result.startswith("www.")
        assert len(result) <= 253
        try:
            ipaddress.ip_address(result)
        except ValueError:
            assert result == "localhost" or all(label_re.fullmatch(x) for x in result.split("."))


@pytest.mark.parametrize("case", PROTOCOL_FIXTURE["validV1"])
def test_v1_protocol_fixture_accepts_valid_terminal_markers(case):
    parsed = parse_browser_title(case["rawTitle"])
    assert parsed.marker_version == 1
    assert parsed.original_title == case["originalTitle"]
    assert parsed.reduced_url == case["reducedUrl"]


@pytest.mark.parametrize("title", PROTOCOL_FIXTURE["invalidOrOrdinary"])
def test_v1_protocol_fixture_fails_closed_for_invalid_or_ordinary_titles(title):
    parsed = parse_browser_title(title)
    assert parsed.marker_version is None
    assert parsed.original_title == title
    assert parsed.reduced_url is None
    assert parse_domain(title) is None


def test_v1_fields_derive_only_normalized_domain_and_clean_title():
    raw = (
        "  Pull request  "
        " [[https://www.GitHub.com:8443/openai/example/pull/42:TIME_URL_V1]]"
    )
    parsed = parse_browser_title(raw)
    fields = browser_privacy_fields(raw)

    assert parsed.original_title == "  Pull request  "
    assert parsed.reduced_url == "https://www.GitHub.com:8443/openai/example/pull/42"
    assert fields.title == "Pull request"
    assert fields.domain == "github.com"
    assert not hasattr(fields, "reduced_url")


@pytest.mark.parametrize(
    "candidate",
    [
        "",
        "not a url",
        "ftp://example.com/a",
        "https://example.com/a?secret=1",
        "https://example.com/a#secret",
        "https://user@example.com/a",
        "https://example.com:bad/a",
        "https://[broken/a",
        "https://example.com/a b",
        "https://example.com/a\x00b",
        "https://example.com/" + "a" * 8_173,
    ],
)
def test_v1_parser_rejects_hostile_candidates_without_throwing(candidate):
    raw = f"Page [[{candidate}:TIME_URL_V1]]"
    assert parse_browser_title(raw).reduced_url is None
    assert browser_privacy_fields(raw).domain is None


def test_v1_parser_accepts_candidate_at_total_length_ceiling():
    candidate = "https://example.com/" + "a" * (8_192 - len("https://example.com/"))
    parsed = parse_browser_title(f"Page [[{candidate}:TIME_URL_V1]]")
    assert parsed.reduced_url == candidate
    assert parse_domain(f"Page [[{candidate}:TIME_URL_V1]]") == "example.com"


def test_v1_parser_removes_only_one_owned_separator_and_terminal_marker():
    raw = (
        "Report  [[https://old.example/path:TIME_URL_V1]] "
        "[[https://new.example/current:TIME_URL_V1]]"
    )
    parsed = parse_browser_title(raw)
    assert parsed.original_title == "Report  [[https://old.example/path:TIME_URL_V1]]"
    assert parsed.reduced_url == "https://new.example/current"


def test_non_terminal_and_unknown_markers_bypass_legacy_domain_parsing():
    """The domain fails closed, but the refused URL must not reach the title.

    These titles previously came back verbatim, which meant the one case the
    validated path rejects a marker *for* -- a query string -- was the case that
    got stored intact once title capture was enabled. Failing closed is about
    not deriving a domain from a marker Time could not validate; it was never a
    reason to persist the URL inside it.
    """
    titles = [
        "Page [[https://example.com/path:TIME_URL_V1]] after",
        "Page [[https://example.com/path:TIME_URL_V2]]",
        "Page [[https://example.com/path?secret=1:TIME_URL_V1]]",
    ]
    for title in titles:
        fields = browser_privacy_fields(title)
        assert fields.domain is None
        assert "example.com" not in fields.title
        assert "secret" not in fields.title
        assert "TIME_URL_V" not in fields.title
        assert fields.title.startswith("Page")


# The extension writes a marker that is terminal in ``document.title``. The
# window title this module actually receives is what the browser renders around
# that page title, so the marker arrives non-terminal on the desktop. These
# cases are deliberately absent from the shared protocol fixture: the fixture
# defines the marker grammar both repositories implement, and a browser's own
# window-title suffix is not part of that grammar.
#
# The Edge entries are the shapes a VM pass on 2026-08-17 found unparsed on a
# working extension: Edge renders its own name with a zero-width space, and
# appends a tab count when more than one tab is open. Either one alone left
# website time unattributed for every Edge user.
BROWSER_WINDOW_SUFFIXES = [
    " - Google Chrome",
    " - Mozilla Firefox",
    " - Microsoft Edge",
    " - Brave",
    " - Opera",
    " - Opera GX",
    " - Vivaldi",
    " - Microsoft​ Edge",
    " - Microsoft  Edge",
    " and 2 more pages - Microsoft Edge",
    " and 12 more pages - Microsoft​ Edge",
    " and 1 more page - Google Chrome",
    " - Personal - Microsoft​ Edge",
    " - Work - Brave",
    " - Jonah - Google Chrome",
    " and 4 more pages - Personal - Microsoft  Edge",
]


def test_edge_window_title_captured_from_a_clean_install():
    """The exact title that went unattributed during the 2026-08-17 VM pass.

    Kept verbatim rather than reduced to the pattern it exposed, because the
    reason this survived to a release candidate is that every case in this file
    was written from what the grammar says a browser does. This one is what a
    browser was observed doing.
    """
    fields = browser_privacy_fields(
        "YouTube [[https://www.youtube.com/:TIME_URL_V1]] - Personal - Microsoft​ Edge"
    )
    assert fields.domain == "youtube.com"
    assert fields.title == "YouTube"


@pytest.mark.parametrize("suffix", BROWSER_WINDOW_SUFFIXES)
def test_marker_is_recognized_behind_a_browser_window_suffix(suffix):
    title = f"Docs [[https://developer.chrome.com/:TIME_URL_V1]]{suffix}"
    fields = browser_privacy_fields(title)
    assert fields.domain == "developer.chrome.com"
    assert fields.title == "Docs"
    assert "[[" not in fields.title
    assert "TIME_URL_V" not in fields.title


@pytest.mark.parametrize("suffix", BROWSER_WINDOW_SUFFIXES)
def test_path_marker_from_an_older_extension_still_yields_only_a_domain(suffix):
    title = f"Report [[https://example.com/patients/12345:TIME_URL_V1]]{suffix}"
    fields = browser_privacy_fields(title)
    assert fields.domain == "example.com"
    assert fields.title == "Report"
    assert "12345" not in fields.title


def test_truncated_marker_leaves_no_orphaned_opening_in_the_title():
    # A window title cut inside the marker loses the ":TIME_URL_V1]]" tail, so
    # the strict parser cannot claim it and the legacy URL strip used to leave
    # the marker's own "[[" behind in stored titles.
    truncated = "Google [[https://www.google.com/search"
    fields = browser_privacy_fields(truncated)
    assert fields.title == "Google"
    assert not fields.title.endswith("[[")
    assert fields.domain == "google.com"


def test_browser_suffix_retry_does_not_invent_a_marker():
    for title in [
        "Reviewing - Google Chrome",
        "Page [[https://example.com/a:TIME_URL_V2]] - Google Chrome",
        "Page [[not a url:TIME_URL_V1]] - Google Chrome",
    ]:
        assert browser_privacy_fields(title).domain is None


def test_profile_label_strip_refuses_a_segment_carrying_a_url():
    """A trailing segment with a URL in it is page text, not a profile label.

    Without this the profile strip could consume the marker it exists to expose,
    and a page could earn a domain for a marker it placed mid-title by appending
    a segment of its own.
    """
    fields = browser_privacy_fields(
        "Draft [[https://evil.example/a:TIME_URL_V1]] - see https://other.example/b"
        " - Google Chrome"
    )
    assert fields.domain is None
    assert "evil.example" not in fields.title
    assert "other.example" not in fields.title


def test_tab_count_is_only_stripped_behind_a_browser_name():
    """Matching a browser name is what licenses removing anything else.

    Without that gate the tab-count pattern would strip a page-authored ending
    off any title, which is also how a page could get a mid-title marker of its
    own accepted.
    """
    fields = browser_privacy_fields(
        "Draft [[https://evil.example/a:TIME_URL_V1]] and 2 more pages"
    )
    assert fields.domain is None
    assert "evil.example" not in fields.title


def test_page_authored_double_bracket_survives_when_no_url_is_stripped():
    fields = browser_privacy_fields("Notes [[ - Google Chrome")
    assert fields.title == "Notes [["


def test_normalize_host_accepts_what_a_settings_field_receives():
    assert normalize_host("YouTube.com") == "youtube.com"
    assert normalize_host("  www.netflix.com/browse  ") == "netflix.com"
    assert normalize_host("https://user:pass@music.apple.com:443/us?x=1#y") == (
        "music.apple.com"
    )
    assert normalize_host("cineby.at.") == "cineby.at"


def test_normalize_host_rejects_what_could_never_be_a_stored_domain():
    assert normalize_host("") is None
    assert normalize_host("   ") is None
    assert normalize_host("not a host") is None
    assert normalize_host("1.2.3") is None  # digits, but not an address
    assert normalize_host("https:///path") is None
    assert normalize_host("-leading.example") is None


def test_normalize_host_keeps_the_hosts_a_local_media_server_is_reached_by():
    # A self-hosted Jellyfin or Plex is a media site too, and it answers to a
    # bare name or an address rather than a registrable domain.
    assert normalize_host("http://localhost:8096/web") == "localhost"
    assert normalize_host("192.168.1.50:32400") == "192.168.1.50"

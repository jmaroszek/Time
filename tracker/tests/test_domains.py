import ipaddress
import random
import re
import string

from tracker.domains import parse_domain, sanitize_browser_title


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
    assert sanitize_browser_title(
        "Account - https://user:secret@example.com/private?q=token - Google Chrome"
    ) == "Account"


def test_browser_title_strips_non_http_url_schemes():
    assert sanitize_browser_title("Local file - file:///C:/Users/person/private.txt") == "Local file"


def test_browser_title_strips_trailing_domain():
    assert sanitize_browser_title("Front page - reddit.com - Mozilla Firefox") == "Front page"


def test_browser_title_preserves_non_url_page_name():
    assert sanitize_browser_title("Project notes - Google Chrome") == "Project notes"


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

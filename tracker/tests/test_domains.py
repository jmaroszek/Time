from tracker.domains import parse_domain


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


def test_www_prefix_stripped():
    assert parse_domain("News • www.example.co.uk") == "example.co.uk"

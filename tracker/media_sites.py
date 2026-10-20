"""Websites whose playback can exempt a browser session from AFK.

Product knowledge that holds on any platform: the operating system can say
that something is playing, and this list is how a foreground browser tab earns
the benefit of that signal. dashboard/src/lib/mediaSites.ts mirrors the list so
Settings can say an entry is already covered, and mediaSites.test.ts compares
the two.
"""

from __future__ import annotations

from collections.abc import Collection
from itertools import chain


# Product knowledge rather than a default the user edits: it only narrows a
# positive Windows playback signal so a background media tab cannot exempt an
# unrelated foreground browser tab. Subdomains match their parent entry. The
# reader adds what this misses through the media_domains setting, which is kept
# separate so this list can grow in a later version without touching their
# entries, and so a settings panel never has to show forty-odd familiar names.
_MEDIA_DOMAINS = frozenset(
    {
        "audible.com",
        "bandcamp.com",
        "crackle.com",
        "crunchyroll.com",
        "dailymotion.com",
        "dazn.com",
        "deezer.com",
        "discoveryplus.com",
        "disneyplus.com",
        "espn.com",
        "foxsports.com",
        "fubo.tv",
        "hbomax.com",
        "hulu.com",
        "iheart.com",
        "iheartradio.com",
        "max.com",
        "mixcloud.com",
        "mlb.com",
        "music.amazon.com",
        "music.apple.com",
        "napster.com",
        "nba.com",
        "netflix.com",
        "nfl.com",
        "pandora.com",
        "paramountplus.com",
        "peacocktv.com",
        "philo.com",
        "plex.tv",
        "pluto.tv",
        "primevideo.com",
        "qobuz.com",
        "roku.com",
        "sling.com",
        "soundcloud.com",
        "spotify.com",
        "tidal.com",
        "tubitv.com",
        "twitch.tv",
        "tv.apple.com",
        "vimeo.com",
        "youtube.com",
    }
)


def is_media_domain(
    domain: str | None, extra_domains: Collection[str] = ()
) -> bool:
    """Whether a captured browser domain is a known playback destination.

    `extra_domains` carries the reader's own entries, which are matched exactly
    as the built-ins are: an entry protects itself and its subdomains.
    """
    if not domain:
        return False
    normalized = domain.lower().strip().rstrip(".")
    return any(
        normalized == candidate or normalized.endswith(f".{candidate}")
        for candidate in chain(_MEDIA_DOMAINS, extra_domains)
    )

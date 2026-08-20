"""Conservative foreground-media detection through Windows system sessions.

Windows exposes playback state through Global System Media Transport Controls
(GSMTC). The source identifier is useful for packaged apps but is not a browser
tab identifier, so browser playback also requires a known media domain from
Time's existing URL-in-title signal. Ambiguous or unavailable state deliberately
falls back to ordinary AFK handling.

Apps need no list: GSMTC names its own source, and `source_matches_foreground`
matches that name against the foreground process. Only the browser gate needs
to know which sites are media, which is why the settings field this module
accepts extra domains from is a *website* field.
"""

from __future__ import annotations

import asyncio
from collections.abc import Collection
from itertools import chain
import logging
import re
from typing import Any


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
_GENERIC_PROCESS_STEMS = frozenset(
    {"app", "application", "media", "music", "player", "video"}
)
_SOURCE_TOKEN_RE = re.compile(r"[a-z0-9]+")


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


def source_matches_foreground(
    source_app_id: str,
    process: str,
    app_user_model_id: str | None,
) -> bool:
    """Match a GSMTC source to the foreground identity without fuzzy titles."""
    source = source_app_id.casefold().strip()
    if not source:
        return False
    if app_user_model_id and source == app_user_model_id.casefold().strip():
        return True

    image = process.casefold().replace("/", "\\").rsplit("\\", 1)[-1]
    stem = image.removesuffix(".exe")
    if not stem or stem in _GENERIC_PROCESS_STEMS:
        return source == image

    tokens = _SOURCE_TOKEN_RE.findall(source)
    # Win32 players commonly publish "spotify.exe"; packaged players commonly
    # publish an AUMID token such as "AppleMusicWin" for AppleMusic.exe.
    return source == image or any(
        token == stem or (len(stem) >= 4 and token.startswith(stem))
        for token in tokens
    )


class MediaPlaybackMonitor:
    """Read current GSMTC sessions and answer one foreground-only question."""

    def __init__(self, manager: Any, playing_status: Any):
        self._manager = manager
        self._playing_status = playing_status
        self._failure_reported = False

    def is_foreground_playing(
        self,
        *,
        process: str | None,
        app_user_model_id: str | None,
        domain: str | None,
        browser_processes: Collection[str],
        media_domains: Collection[str] = (),
    ) -> bool:
        if process is None:
            return False
        normalized_process = process.lower()
        is_browser = normalized_process in browser_processes
        if is_browser and not is_media_domain(domain, media_domains):
            return False

        try:
            sessions = self._manager.get_sessions()
        except Exception as exc:
            self._report_failure(exc)
            return False

        self._failure_reported = False
        for session in sessions:
            try:
                if session.get_playback_info().playback_status != self._playing_status:
                    continue
                if source_matches_foreground(
                    session.source_app_user_model_id,
                    normalized_process,
                    app_user_model_id,
                ):
                    return True
            except Exception:
                # One stale Windows media session must not hide a healthy match
                # from another player, or interrupt the tracker loop.
                continue
        return False

    def _report_failure(self, exc: BaseException) -> None:
        if self._failure_reported:
            return
        self._failure_reported = True
        # Do not include the exception message: third-party projections should
        # not be trusted to keep media metadata out of their diagnostics.
        logging.error(
            "Media playback detection failed; ordinary AFK applies | error=%s",
            type(exc).__name__,
        )


async def _request_manager(manager_type: Any) -> Any:
    return await manager_type.request_async()


def start_media_playback_monitor() -> MediaPlaybackMonitor | None:
    """Acquire GSMTC once; return None when Windows or its projection declines."""
    try:
        from winrt.windows.media.control import (
            GlobalSystemMediaTransportControlsSessionManager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus,
        )

        with asyncio.Runner() as runner:
            manager = runner.run(
                _request_manager(GlobalSystemMediaTransportControlsSessionManager)
            )
        return MediaPlaybackMonitor(
            manager,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.PLAYING,
        )
    except Exception as exc:
        logging.error(
            "Media playback detection unavailable; ordinary AFK applies | error=%s",
            type(exc).__name__,
        )
        return None

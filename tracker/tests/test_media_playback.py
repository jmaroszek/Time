from __future__ import annotations

import logging

from tracker.media_playback import (
    MediaPlaybackMonitor,
    is_media_domain,
    source_matches_foreground,
)


PLAYING = object()
PAUSED = object()
BROWSERS = frozenset({"chrome.exe", "msedge.exe", "firefox.exe"})


class _PlaybackInfo:
    def __init__(self, status):
        self.playback_status = status


class _Session:
    def __init__(self, source: str, status=PLAYING):
        self.source_app_user_model_id = source
        self._status = status

    def get_playback_info(self):
        return _PlaybackInfo(self._status)


class _Manager:
    def __init__(self, sessions):
        self._sessions = sessions

    def get_sessions(self):
        return self._sessions


def _monitor(*sessions):
    return MediaPlaybackMonitor(_Manager(sessions), PLAYING)


def test_media_domains_include_subdomains_but_not_unrelated_sites():
    assert is_media_domain("youtube.com")
    assert is_media_domain("music.youtube.com")
    assert is_media_domain("open.spotify.com")
    assert not is_media_domain("docs.google.com")
    assert not is_media_domain(None)


def test_source_matches_exact_aumid_before_process_fallback():
    source = "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"
    assert source_matches_foreground(source, "applicationframehost.exe", source)


def test_source_matches_desktop_image_and_packaged_image_token():
    assert source_matches_foreground("Spotify.exe", "spotify.exe", None)
    assert source_matches_foreground(
        "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App",
        "applemusic.exe",
        None,
    )


def test_browsers_match_the_source_ids_windows_was_observed_publishing():
    # Captured from a live GSMTC session (scripts/capture_gsmtc.py) rather than
    # assumed: Edge publishes "MSEdge" and Chrome publishes "Chrome". Pinned
    # here because the plausible-sounding guess -- "Microsoft.Edge" -- is not
    # reachable from stem `msedge` by any rule above, so a future change made
    # against the guess rather than the observation would look correct and
    # silently stop exempting browser media from AFK.
    assert source_matches_foreground("MSEdge", "msedge.exe", None)
    assert source_matches_foreground("Chrome", "chrome.exe", None)


def test_a_browser_source_does_not_vouch_for_a_different_browser():
    assert not source_matches_foreground("MSEdge", "chrome.exe", None)
    assert not source_matches_foreground("Chrome", "msedge.exe", None)


def test_generic_process_stem_does_not_fuzzily_match_an_aumid():
    assert not source_matches_foreground(
        "Contoso.MusicPlayer_123!App",
        "music.exe",
        None,
    )


def test_foreground_desktop_player_is_protected_only_while_playing():
    playing = _monitor(_Session("Spotify.exe"))
    paused = _monitor(_Session("Spotify.exe", PAUSED))
    args = {
        "process": "spotify.exe",
        "app_user_model_id": None,
        "domain": None,
        "browser_processes": BROWSERS,
    }
    assert playing.is_foreground_playing(**args)
    assert not paused.is_foreground_playing(**args)


def test_browser_requires_both_playback_and_a_known_foreground_domain():
    monitor = _monitor(_Session("chrome.exe"))
    base = {
        "process": "chrome.exe",
        "app_user_model_id": None,
        "browser_processes": BROWSERS,
    }
    assert monitor.is_foreground_playing(domain="youtube.com", **base)
    assert not monitor.is_foreground_playing(domain="docs.google.com", **base)
    assert not monitor.is_foreground_playing(domain=None, **base)


def test_playing_session_from_another_app_does_not_protect_foreground():
    monitor = _monitor(_Session("Spotify.exe"))
    assert not monitor.is_foreground_playing(
        process="vlc.exe",
        app_user_model_id=None,
        domain=None,
        browser_processes=BROWSERS,
    )


def test_stale_session_does_not_hide_a_later_healthy_match():
    class _Stale:
        def get_playback_info(self):
            raise OSError("session disappeared")

    monitor = _monitor(_Stale(), _Session("Spotify.exe"))
    assert monitor.is_foreground_playing(
        process="spotify.exe",
        app_user_model_id=None,
        domain=None,
        browser_processes=BROWSERS,
    )


def test_manager_failure_falls_back_and_logs_once(caplog):
    class _Broken:
        def get_sessions(self):
            raise RuntimeError("private media metadata must not be logged")

    caplog.set_level(logging.ERROR)
    monitor = MediaPlaybackMonitor(_Broken(), PLAYING)
    args = {
        "process": "spotify.exe",
        "app_user_model_id": None,
        "domain": None,
        "browser_processes": BROWSERS,
    }
    assert not monitor.is_foreground_playing(**args)
    assert not monitor.is_foreground_playing(**args)
    records = [r.getMessage() for r in caplog.records]
    assert len(records) == 1
    assert "private media metadata" not in records[0]


def test_reader_added_domains_extend_the_built_in_list():
    assert not is_media_domain("mubi.com")
    assert is_media_domain("mubi.com", {"mubi.com"})
    # Additions match subdomains exactly as the built-ins do.
    assert is_media_domain("watch.mubi.com", {"mubi.com"})
    # And they only widen: an addition cannot retire a built-in.
    assert is_media_domain("youtube.com", {"mubi.com"})


def test_added_domain_protects_a_browser_the_built_in_list_misses():
    monitor = _monitor(_Session("chrome.exe"))
    base = {
        "process": "chrome.exe",
        "app_user_model_id": None,
        "browser_processes": BROWSERS,
    }
    assert not monitor.is_foreground_playing(domain="mubi.com", **base)
    assert monitor.is_foreground_playing(
        domain="mubi.com", media_domains={"mubi.com"}, **base
    )


def test_added_domain_cannot_protect_an_unrelated_foreground_tab():
    # The domain gate widens; the source gate does not. A playing Spotify tab
    # must not exempt a browser sitting on an added site.
    monitor = _monitor(_Session("Spotify.exe"))
    assert not monitor.is_foreground_playing(
        process="chrome.exe",
        app_user_model_id=None,
        domain="mubi.com",
        browser_processes=BROWSERS,
        media_domains={"mubi.com"},
    )

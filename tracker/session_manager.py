"""Pure session state machine: turns per-second snapshots into session intervals.

No Win32 or sqlite imports here — inputs arrive as `Snapshot`s and outputs go
through a `Store` protocol, so the whole machine is unit-testable with fakes.

Behavior spec:
- App change splits the session immediately.
- Title change must persist `debounce_ticks` consecutive ticks before splitting
  (prevents "Updating..." flicker rows); the split is back-dated to when the
  new title first appeared.
- Idle >= threshold finalizes the active session back-dated to the last input
  (now - idle_seconds) and opens an AFK session from that point, unless a
  foreground media session is actively playing.
- Awake idle retains the foreground process/domain but remains `is_afk=1`;
  window content is replaced by the reason. Lock remains identity-free AFK.
- Lock screen (lockapp.exe foreground) becomes AFK immediately, no threshold.
- Unknown foreground (None process) never splits; the current session persists.
- System suspend closes the current session; resume starts a fresh recording
  boundary so idle backdating can never cover the sleeping interval.
- An open session's end_ts is pushed forward by heartbeat so a crash loses at
  most `heartbeat_seconds`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from tracker.domains import browser_privacy_fields

LOCK_PROCESS = "lockapp.exe"
AFK_PROCESS = "afk"


@dataclass(frozen=True)
class Snapshot:
    now: float  # unix wall-clock seconds
    idle_seconds: float
    process: str | None  # lowercased exe name; None when foreground is unknown
    title: str
    app_user_model_id: str | None = None
    media_playing: bool = False


@dataclass(frozen=True)
class Settings:
    idle_threshold_seconds: float = 300.0
    heartbeat_seconds: float = 15.0
    browser_processes: frozenset[str] = frozenset(
        {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe"}
    )
    debounce_ticks: int = 2
    # Production passes both privacy choices explicitly from SQLite. Defaults
    # stay enabled here so isolated state-machine callers retain useful behavior.
    recording_consent: bool = True
    record_window_titles: bool = True
    # Set from the tray (or dashboard) via the tracking_paused settings keys;
    # picked up by the live tracker on its next one-second poll.
    tracking_paused: bool = False
    # Scheduling is a separate gate so reaching the start of a work window can
    # never undo a manual pause. The window start clamps AFK backdating.
    recording_schedule_allowed: bool = True
    recording_schedule_window_start: float = 0.0
    # Exact, normalized identities that must never produce a stored session.
    # Domains are still derived when title storage is disabled, so website
    # exclusions do not weaken the title-privacy default.
    excluded_processes: frozenset[str] = frozenset()
    excluded_domains: frozenset[str] = frozenset()


class Store(Protocol):
    def open_session(
        self, start_ts: float, process: str, title: str, domain: str | None, is_afk: bool
    ) -> int | None: ...

    def close_session(self, session_id: int, end_ts: float) -> None: ...

    def heartbeat(self, session_id: int, end_ts: float) -> None: ...


@dataclass
class _Current:
    id: int
    start_ts: float
    process: str
    title: str
    domain: str | None
    is_afk: bool


@dataclass
class SessionManager:
    store: Store
    settings: Settings = field(default_factory=Settings)

    _current: _Current | None = None
    _pending_identity: tuple[str, str | None] | None = None
    _pending_first_ts: float = 0.0
    _pending_count: int = 0
    _last_heartbeat: float = 0.0
    _last_observed_ts: float = 0.0
    _system_suspended: bool = False
    _media_protected_idle: bool = False
    _recording_blocked: bool | None = None
    # Highest end_ts this run has written via close. Opens clamp to it so a
    # wall clock stepped backwards while no session is current (post-pause,
    # post-AFK-unknown) cannot open a row overlapping an already-closed one
    # (pinned by the cross-half contract test, which caught this case).
    _floor_ts: float = 0.0

    # ---------- public API ----------

    def tick(self, snap: Snapshot) -> None:
        if self._system_suspended:
            return
        self._last_observed_ts = snap.now
        blocked = (
            self.settings.tracking_paused
            or not self.settings.recording_consent
            or not self.settings.recording_schedule_allowed
        )
        if blocked:
            # Every recording gate finalizes the open session and opens nothing
            # new. A schedule never mutates the independent manual-pause keys.
            if self._current is not None:
                self._close(self._current.id, max(snap.now, self._current.start_ts))
                self._current = None
            self._reset_pending()
            self._media_protected_idle = False
            self._recording_blocked = True
            return

        if self._recording_blocked:
            # A resume must not let idle backdating reach into a manual pause or
            # the off-hours window that just ended.
            self._floor_ts = max(self._floor_ts, snap.now)
        elif self._recording_blocked is None:
            # On tracker startup inside a window, retain normal idle backdating
            # but never let it cross the schedule's opening boundary.
            self._floor_ts = max(
                self._floor_ts, self.settings.recording_schedule_window_start
            )
        self._recording_blocked = False

        locked = snap.process == LOCK_PROCESS
        idle = snap.idle_seconds >= self.settings.idle_threshold_seconds
        media_protected = idle and not locked and snap.media_playing
        if locked or (idle and not media_protected):
            self._tick_afk(snap, locked)
        else:
            self._tick_active(snap)
        self._media_protected_idle = media_protected
        self._maybe_heartbeat(snap.now)

    def system_suspended(self, now: float) -> None:
        """End the awake interval without inventing a session during sleep."""
        if self._system_suspended:
            return
        if self._current is not None:
            self._close(self._current.id, max(now, self._current.start_ts))
            self._current = None
        self._reset_pending()
        self._media_protected_idle = False
        self._system_suspended = True

    def system_resumed(self, now: float) -> None:
        """Start a new awake interval and forbid pre-resume backdating."""
        if not self._system_suspended and self._current is not None:
            # A critical or otherwise unpaired resume means Windows did not
            # deliver suspend to this process. Preserve only the time actually
            # observed by the tracker rather than stretching the row to wake.
            boundary = max(self._last_observed_ts, self._current.start_ts)
            self._close(self._current.id, boundary)
            self._current = None
        self._system_suspended = False
        self._floor_ts = max(self._floor_ts, now)
        self._reset_pending()
        self._media_protected_idle = False

    def shutdown(self, now: float) -> None:
        """Finalize the open session (process exit, ctrl-c, logoff)."""
        if self._current is not None:
            self._close(self._current.id, max(now, self._current.start_ts))
            self._current = None

    # ---------- AFK ----------

    def _tick_afk(self, snap: Snapshot, locked: bool) -> None:
        if self._current is not None and self._current.is_afk:
            return  # already AFK; idle -> locked transitions stay one span

        reason = "locked" if locked else "idle"
        # Lock is detected the moment it happens; idle is detected late, so the
        # boundary is normally back-dated to the last real input. If playback
        # was protecting an already-idle session, stopping playback is the new
        # observed boundary; backdating would erase the media time just counted.
        boundary = (
            snap.now
            if locked or self._media_protected_idle
            else snap.now - snap.idle_seconds
        )
        if locked:
            retained_process, retained_domain = AFK_PROCESS, None
        else:
            retained_process, retained_domain = self._retained_afk_identity(snap)
        if self._current is not None:
            boundary = max(boundary, self._current.start_ts)
            self._close(self._current.id, boundary)
        else:
            boundary = max(boundary, 0.0)
        self._open_afk(
            boundary,
            retained_process,
            reason,
            retained_domain,
        )
        self._reset_pending()

    # ---------- active ----------

    def _tick_active(self, snap: Snapshot) -> None:
        cur = self._current

        # Exclusions bypass the title debounce: once an excluded website or app
        # is visible, the previous allowed session ends immediately and no part
        # of the excluded identity is opened as a session.
        if snap.process is not None:
            _, domain = self._privacy_fields(snap.process, snap.title)
            if self._is_excluded(snap.process, domain):
                if cur is not None:
                    boundary = max(snap.now, cur.start_ts)
                    self._close(cur.id, boundary)
                    self._current = None
                self._reset_pending()
                return

        if cur is None:
            if snap.process is not None:
                self._open(snap.now, snap.process, snap.title)
            return

        if cur.is_afk:
            # max() clamps against a wall clock stepped backwards mid-session
            # (NTP step / manual change), which would otherwise write a
            # negative-duration row that the dashboard silently drops.
            boundary = max(snap.now, cur.start_ts)
            self._close(cur.id, boundary)
            if snap.process is not None:
                self._open(boundary, snap.process, snap.title)
            else:
                self._current = None
            return

        if snap.process is None:
            return  # transient unknown foreground: keep current session running

        if snap.process != cur.process:
            boundary = max(snap.now, cur.start_ts)  # clock set-back clamp, as above
            self._close(cur.id, boundary)
            self._open(boundary, snap.process, snap.title)
            self._reset_pending()
            return

        next_title, next_domain = self._privacy_fields(snap.process, snap.title)
        identity = (next_title, next_domain)
        if identity != (cur.title, cur.domain):
            if identity == self._pending_identity:
                self._pending_count += 1
            else:
                self._pending_identity = identity
                self._pending_first_ts = snap.now
                self._pending_count = 1
            if self._pending_count >= self.settings.debounce_ticks:
                boundary = max(self._pending_first_ts, cur.start_ts)
                self._close(cur.id, boundary)
                self._open(boundary, snap.process, snap.title)
                self._reset_pending()
        else:
            self._reset_pending()

    # ---------- helpers ----------

    def _close(self, session_id: int, end_ts: float) -> None:
        self.store.close_session(session_id, end_ts)
        self._floor_ts = max(self._floor_ts, end_ts)

    def _open(self, start_ts: float, process: str, title: str) -> None:
        stored_title, domain = self._privacy_fields(process, title)
        self._open_stored(start_ts, process, stored_title, domain, is_afk=False)

    def _open_afk(
        self,
        start_ts: float,
        process: str,
        reason: str,
        domain: str | None,
    ) -> None:
        # Never persist the foreground title while the user is away. The reason
        # remains in the existing title column, avoiding a schema migration
        # while process/domain preserve enough identity for later inspection.
        self._open_stored(start_ts, process, reason, domain, is_afk=True)

    def _open_stored(
        self,
        start_ts: float,
        process: str,
        stored_title: str,
        domain: str | None,
        *,
        is_afk: bool,
    ) -> None:
        # Clamp against _floor_ts: a no-op while the clock is monotonic (every
        # open follows its close at the same boundary), it only engages when a
        # set-back would start this row before an already-written end.
        start_ts = max(start_ts, self._floor_ts)
        session_id = self.store.open_session(
            start_ts, process, stored_title, domain, is_afk
        )
        if session_id is None:
            self._current = None
            return
        self._current = _Current(
            session_id, start_ts, process, stored_title, domain, is_afk
        )

    def _retained_afk_identity(self, snap: Snapshot) -> tuple[str, str | None]:
        if self._current is not None and not self._current.is_afk:
            process = self._current.process
            domain = self._current.domain
        elif snap.process is not None:
            process = snap.process
            _, domain = self._privacy_fields(process, snap.title)
        else:
            return AFK_PROCESS, None

        # An exclusion is a promise not to store the identity at all, including
        # after that app or website becomes idle.
        if self._is_excluded(process, domain):
            return AFK_PROCESS, None
        return process, domain

    def _is_excluded(self, process: str, domain: str | None) -> bool:
        normalized_process = process.lower()
        if normalized_process in self.settings.excluded_processes:
            return True
        return bool(
            normalized_process in self.settings.browser_processes
            and domain
            and domain.lower() in self.settings.excluded_domains
        )

    def _privacy_fields(self, process: str, raw_title: str) -> tuple[str, str | None]:
        is_browser = process in self.settings.browser_processes
        if is_browser:
            # Parse once so the title and domain cannot disagree about whether
            # a V1 marker was valid. browser_privacy_fields discards the raw
            # origin/path before returning from the privacy boundary.
            fields = browser_privacy_fields(raw_title)
            return (
                fields.title if self.settings.record_window_titles else "",
                fields.domain,
            )
        if not self.settings.record_window_titles:
            return "", None
        return raw_title.replace("\x00", "")[:512], None

    def _reset_pending(self) -> None:
        self._pending_identity = None
        self._pending_first_ts = 0.0
        self._pending_count = 0

    def _maybe_heartbeat(self, now: float) -> None:
        if self._current is None:
            return
        if now - self._last_heartbeat >= self.settings.heartbeat_seconds:
            self.store.heartbeat(self._current.id, max(now, self._current.start_ts))
            self._last_heartbeat = now

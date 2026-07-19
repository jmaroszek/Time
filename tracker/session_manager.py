"""Pure session state machine: turns per-second snapshots into session intervals.

No Win32 or sqlite imports here — inputs arrive as `Snapshot`s and outputs go
through a `Store` protocol, so the whole machine is unit-testable with fakes.

Behavior spec (mirrors the refactor plan):
- App change splits the session immediately.
- Title change must persist `debounce_ticks` consecutive ticks before splitting
  (prevents "Updating..." flicker rows); the split is back-dated to when the
  new title first appeared.
- Idle >= threshold finalizes the active session back-dated to the last input
  (now - idle_seconds) and opens an AFK session from that point.
- Lock screen (lockapp.exe foreground) becomes AFK immediately, no threshold.
- Unknown foreground (None process) never splits; the current session persists.
- An open session's end_ts is pushed forward by heartbeat so a crash loses at
  most `heartbeat_seconds`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from tracker.domains import parse_domain, sanitize_browser_title

LOCK_PROCESS = "lockapp.exe"
AFK_PROCESS = "afk"


@dataclass(frozen=True)
class Snapshot:
    now: float  # unix wall-clock seconds
    idle_seconds: float
    process: str | None  # lowercased exe name; None when foreground is unknown
    title: str


@dataclass(frozen=True)
class Settings:
    idle_threshold_seconds: float = 180.0
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


class Store(Protocol):
    def open_session(
        self, start_ts: float, process: str, title: str, domain: str | None, is_afk: bool
    ) -> int: ...

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
    # Highest end_ts this run has written via close. Opens clamp to it so a
    # wall clock stepped backwards while no session is current (post-pause,
    # post-AFK-unknown) cannot open a row overlapping an already-closed one
    # (DATA-002 family; caught by the TEST-002 contract test).
    _floor_ts: float = 0.0

    # ---------- public API ----------

    def tick(self, snap: Snapshot) -> None:
        if self.settings.tracking_paused or not self.settings.recording_consent:
            # Pause = finalize the open session and open nothing new. Resuming
            # simply lets the next tick open a fresh session.
            if self._current is not None:
                self._close(self._current.id, max(snap.now, self._current.start_ts))
                self._current = None
            self._reset_pending()
            return

        locked = snap.process == LOCK_PROCESS
        idle = snap.idle_seconds >= self.settings.idle_threshold_seconds
        if locked or idle:
            self._tick_afk(snap, locked)
        else:
            self._tick_active(snap)
        self._maybe_heartbeat(snap.now)

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
        # boundary is back-dated to the last real input.
        boundary = snap.now if locked else snap.now - snap.idle_seconds
        if self._current is not None:
            boundary = max(boundary, self._current.start_ts)
            self._close(self._current.id, boundary)
        else:
            boundary = max(boundary, 0.0)
        self._open(boundary, AFK_PROCESS, reason, is_afk=True)
        self._reset_pending()

    # ---------- active ----------

    def _tick_active(self, snap: Snapshot) -> None:
        cur = self._current

        if cur is None:
            if snap.process is not None:
                self._open(snap.now, snap.process, snap.title)
            return

        if cur.is_afk:
            # max() clamps against a wall clock stepped backwards mid-session
            # (NTP step / manual change), which would otherwise write a
            # negative-duration row the dashboard silently drops (DATA-002).
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
            boundary = max(snap.now, cur.start_ts)  # DATA-002 clamp, as above
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

    def _open(self, start_ts: float, process: str, title: str, is_afk: bool = False) -> None:
        # Clamp against _floor_ts: a no-op while the clock is monotonic (every
        # open follows its close at the same boundary), it only engages when a
        # set-back would start this row before an already-written end.
        start_ts = max(start_ts, self._floor_ts)
        if is_afk:
            stored_title, domain = title, None
        else:
            stored_title, domain = self._privacy_fields(process, title)
        session_id = self.store.open_session(
            start_ts, process, stored_title, domain, is_afk
        )
        self._current = _Current(
            session_id, start_ts, process, stored_title, domain, is_afk
        )

    def _privacy_fields(self, process: str, raw_title: str) -> tuple[str, str | None]:
        is_browser = process in self.settings.browser_processes
        domain = parse_domain(raw_title) if is_browser else None
        if not self.settings.record_window_titles:
            return "", domain
        if is_browser:
            return sanitize_browser_title(raw_title), domain
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

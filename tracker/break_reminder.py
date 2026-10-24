"""When to suggest a break: continuous activity measured against one interval.

Pure, like session_manager: it reads the same snapshots and settings the loop
already has and returns a verdict, so the rules are testable without a
notification ever being shown.

Rules:
- Activity accumulates between polls while the user is present. Idle below the
  AFK threshold is still presence — reading counts.
- A break is what Time already calls away: idle past the AFK threshold, the
  lock screen, or an interval the loop did not observe that was at least that
  long (sleep, a frozen loop). A break starts the count from zero.
- Media playing hands-off holds the count. Watching is not the screen work a
  break interrupts, and it is not rest from the screen either.
- Pause, the tracking schedule, and missing consent reset rather than hold: a
  Time that is not recording is not watching either, and resuming starts fresh.
- One reminder per stretch. It is shown when due, never deferred; Windows' own
  Do Not Disturb decides whether a moment is interruptible.
"""

from __future__ import annotations

from dataclasses import dataclass

from tracker.session_manager import LOCK_PROCESS, Settings, Snapshot, is_idle


@dataclass
class BreakReminder:
    _active_seconds: float = 0.0
    _last_now: float | None = None
    _fired: bool = False

    def observe(self, snap: Snapshot, settings: Settings) -> int | None:
        """Advance by one poll. Returns the stretch in minutes when a reminder is due."""
        recording = (
            settings.recording_consent
            and not settings.tracking_paused
            and settings.recording_schedule_allowed
        )
        if not settings.break_reminder_enabled or not recording:
            self.reset()
            return None

        elapsed = 0.0 if self._last_now is None else snap.now - self._last_now
        self._last_now = snap.now
        if elapsed >= settings.idle_threshold_seconds:
            self._start_stretch()
            elapsed = 0.0

        idle = is_idle(snap, settings)
        if snap.process == LOCK_PROCESS or (idle and not snap.media_playing):
            self._start_stretch()
            return None
        if idle:
            return None  # hands-off media: hold

        # A clock stepped backwards measured nothing.
        self._active_seconds += max(elapsed, 0.0)
        if self._fired or self._active_seconds < settings.break_reminder_seconds:
            return None
        self._fired = True
        return round(self._active_seconds / 60)

    def reset(self) -> None:
        """Forget the stretch, including when it was last observed."""
        self._start_stretch()
        self._last_now = None

    def _start_stretch(self) -> None:
        self._active_seconds = 0.0
        self._fired = False

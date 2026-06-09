"""State machine tests driven by a fake store and synthetic snapshots."""

from __future__ import annotations

import pytest

from tracker.session_manager import AFK_PROCESS, SessionManager, Settings, Snapshot


class FakeStore:
    def __init__(self):
        self.next_id = 1
        self.opened = []  # (id, start_ts, process, title, domain, is_afk)
        self.closed = {}  # id -> end_ts
        self.heartbeats = []  # (id, end_ts)

    def open_session(self, start_ts, process, title, domain, is_afk):
        sid = self.next_id
        self.next_id += 1
        self.opened.append((sid, start_ts, process, title, domain, is_afk))
        return sid

    def close_session(self, session_id, end_ts):
        self.closed[session_id] = end_ts

    def heartbeat(self, session_id, end_ts):
        self.heartbeats.append((session_id, end_ts))


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def manager(store):
    return SessionManager(store=store, settings=Settings())


def active(now, process="code.exe", title="main.py", idle=0.0):
    return Snapshot(now=now, idle_seconds=idle, process=process, title=title)


def drive(manager, t0, seconds, **kwargs):
    """Tick once per second from t0 for `seconds` ticks with the same snapshot."""
    for i in range(seconds):
        manager.tick(active(t0 + i, **kwargs))


# ---------------- basic transitions ----------------


def test_first_tick_opens_session(manager, store):
    manager.tick(active(1000.0))
    assert store.opened == [(1, 1000.0, "code.exe", "main.py", None, False)]


def test_app_switch_closes_and_opens_immediately(manager, store):
    manager.tick(active(1000.0, process="code.exe"))
    manager.tick(active(1010.0, process="obsidian.exe", title="Notes"))
    assert store.closed[1] == 1010.0
    assert store.opened[1] == (2, 1010.0, "obsidian.exe", "Notes", None, False)


def test_same_app_same_title_no_new_session(manager, store):
    drive(manager, 1000.0, 30)
    assert len(store.opened) == 1
    assert store.closed == {}


def test_unknown_foreground_does_not_split(manager, store):
    manager.tick(active(1000.0))
    manager.tick(Snapshot(now=1001.0, idle_seconds=0.0, process=None, title=""))
    manager.tick(active(1002.0))
    assert len(store.opened) == 1
    assert store.closed == {}


def test_unknown_foreground_with_no_session_opens_nothing(manager, store):
    manager.tick(Snapshot(now=1000.0, idle_seconds=0.0, process=None, title=""))
    assert store.opened == []


# ---------------- title debounce ----------------


def test_one_tick_title_flicker_does_not_split(manager, store):
    manager.tick(active(1000.0, title="Skill Tree"))
    manager.tick(active(1001.0, title="Updating..."))
    manager.tick(active(1002.0, title="Skill Tree"))
    drive(manager, 1003.0, 5, title="Skill Tree")
    assert len(store.opened) == 1


def test_persistent_title_change_splits_backdated(manager, store):
    manager.tick(active(1000.0, title="Page A"))
    manager.tick(active(1005.0, title="Page B"))  # first appearance
    manager.tick(active(1006.0, title="Page B"))  # second consecutive tick -> split
    assert store.closed[1] == 1005.0  # back-dated to first appearance
    assert store.opened[1][1] == 1005.0
    assert store.opened[1][3] == "Page B"


def test_title_zigzag_resets_debounce(manager, store):
    manager.tick(active(1000.0, title="A"))
    manager.tick(active(1001.0, title="B"))
    manager.tick(active(1002.0, title="C"))
    manager.tick(active(1003.0, title="A"))
    assert len(store.opened) == 1


def test_app_switch_resets_title_debounce(manager, store):
    manager.tick(active(1000.0, process="code.exe", title="A"))
    manager.tick(active(1001.0, process="code.exe", title="B"))
    manager.tick(active(1002.0, process="obsidian.exe", title="B"))
    manager.tick(active(1003.0, process="obsidian.exe", title="B"))
    # only the app switch split; no extra title split afterwards
    assert len(store.opened) == 2


# ---------------- AFK ----------------


def test_idle_threshold_backdates_to_last_input(manager, store):
    manager.tick(active(1000.0))
    manager.tick(active(1180.0, idle=180.0))  # idle crossed threshold
    # session must end at last input: 1180 - 180 = 1000
    assert store.closed[1] == 1000.0
    sid, start, proc, title, domain, is_afk = store.opened[1]
    assert (start, proc, title, is_afk) == (1000.0, AFK_PROCESS, "idle", True)


def test_backdate_never_precedes_session_start(manager, store):
    # session starts at 1100 but last input was at 1000 (idle counts across the open)
    manager.tick(active(1100.0, idle=100.0))
    manager.tick(active(1280.0, idle=280.0))
    assert store.closed[1] == 1100.0  # clamped to session start, not 1000


def test_lock_is_immediate_afk(manager, store):
    manager.tick(active(1000.0))
    manager.tick(active(1005.0, process="lockapp.exe", title="Lock", idle=5.0))
    assert store.closed[1] == 1005.0  # no back-dating, no threshold wait
    assert store.opened[1][2] == AFK_PROCESS
    assert store.opened[1][3] == "locked"


def test_idle_then_lock_stays_one_afk_span(manager, store):
    manager.tick(active(1000.0))
    manager.tick(active(1180.0, idle=180.0))
    manager.tick(active(1200.0, process="lockapp.exe", title="Lock", idle=200.0))
    assert len(store.opened) == 2  # active + single afk session


def test_resume_from_afk_opens_fresh_session(manager, store):
    manager.tick(active(1000.0))
    manager.tick(active(1180.0, idle=180.0))
    manager.tick(active(1300.0, idle=1.0, title="back"))
    afk_id = store.opened[1][0]
    assert store.closed[afk_id] == 1300.0
    assert store.opened[2][1] == 1300.0
    assert store.opened[2][5] is False


def test_afk_while_no_session_opens_afk(manager, store):
    manager.tick(Snapshot(now=1000.0, idle_seconds=500.0, process="code.exe", title="x"))
    assert store.opened[0][2] == AFK_PROCESS


# ---------------- heartbeat ----------------


def test_heartbeat_updates_end_ts(manager, store):
    drive(manager, 1000.0, 31)
    assert len(store.heartbeats) >= 2
    sid, end_ts = store.heartbeats[-1]
    assert sid == 1
    assert end_ts >= 1015.0


def test_heartbeat_respects_cadence(store):
    manager = SessionManager(store=store, settings=Settings(heartbeat_seconds=10.0))
    drive(manager, 1000.0, 25)
    # first tick heartbeats (last_heartbeat starts at 0), then every 10s
    gaps = [
        b[1] - a[1]
        for a, b in zip(store.heartbeats, store.heartbeats[1:])
    ]
    assert all(g >= 10.0 for g in gaps)


# ---------------- domains ----------------


def test_browser_session_gets_domain(manager, store):
    manager.tick(active(1000.0, process="chrome.exe", title="Video - https://youtube.com/watch?v=1"))
    assert store.opened[0][4] == "youtube.com"


def test_non_browser_session_has_no_domain(manager, store):
    manager.tick(active(1000.0, process="code.exe", title="https://example.com docs"))
    assert store.opened[0][4] is None


# ---------------- shutdown ----------------


def test_shutdown_finalizes_open_session(manager, store):
    manager.tick(active(1000.0))
    manager.shutdown(1042.0)
    assert store.closed[1] == 1042.0


def test_shutdown_with_no_session_is_noop(manager, store):
    manager.shutdown(1000.0)
    assert store.closed == {}

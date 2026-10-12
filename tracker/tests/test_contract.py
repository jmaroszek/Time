"""Cross-half contract test.

Drives SessionManager with randomized snapshot sequences — sleep gaps, clock
jitter, debounce storms, AFK cycles, pauses — against the *real* SqliteStore on
a temp DB, then asserts the global invariants the dashboard relies on:

  1. end_ts >= start_ts for every row (negative durations are silently dropped
     by the dashboard's clipSessions — they must never be written).
  2. AFK rows carry a domain only with a retained foreground process.
  3. Positive-duration rows never overlap each other, including AFK rows
     (half-open interval semantics).

Deterministic: fixed seeds, no wall clock. This test caught the open-path
clock-set-back overlap the _floor_ts clamp in session_manager now prevents.
"""

from __future__ import annotations

import random
from dataclasses import replace

import pytest

from tracker import db
from tracker.session_manager import SessionManager, Settings, Snapshot

PROCS = ["code.exe", "chrome.exe", "obsidian.exe", "explorer.exe", "lockapp.exe", None]
TITLES = [
    "main.py - repo",
    "Updating...",
    "Video - https://youtube.com/watch?v=1",
    "Doc • docs.google.com",
    "Untitled",
    "",
]


def _run_walk(conn, seed: int, ticks: int, *, clock_setbacks: bool, pauses: bool) -> float:
    rng = random.Random(seed)
    store = db.SqliteStore(conn)
    settings = Settings(
        idle_threshold_seconds=180.0,
        heartbeat_seconds=float(rng.choice([5, 7, 15])),
        tracking_paused=False,
    )
    manager = SessionManager(store=store, settings=settings)

    now = 1_700_000_000.0
    max_now = now
    idle = 0.0
    proc: str | None = "code.exe"
    title = TITLES[0]

    for _ in range(ticks):
        r = rng.random()
        if r < 0.02:
            now += rng.uniform(60, 4000)  # suspend / sleep gap
        elif clock_setbacks and r < 0.04:
            now -= rng.uniform(1, 600)  # NTP step / manual clock change
        else:
            now += 1.0
        max_now = max(max_now, now)

        if rng.random() < 0.12:
            idle += rng.uniform(1, 150)  # hands off the keyboard
        else:
            idle = rng.uniform(0.0, 2.0)
        if rng.random() < 0.15:
            proc = rng.choice(PROCS)
        if rng.random() < 0.35:
            title = rng.choice(TITLES)  # includes flicker storms

        if pauses and rng.random() < 0.03:
            manager.settings = Settings(
                heartbeat_seconds=settings.heartbeat_seconds,
                tracking_paused=not manager.settings.tracking_paused,
            )

        manager.tick(Snapshot(now=now, idle_seconds=idle, process=proc, title=title))

    manager.shutdown(max_now)
    return max_now


def _assert_invariants(conn, *, check_overlaps: bool) -> None:
    negative = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE end_ts < start_ts"
    ).fetchone()[0]
    assert negative == 0, f"{negative} negative-duration rows written"

    orphaned_afk_domains = conn.execute(
        "SELECT COUNT(*) FROM sessions"
        " WHERE is_afk = 1 AND domain IS NOT NULL AND process = 'afk'"
    ).fetchone()[0]
    assert orphaned_afk_domains == 0, (
        f"{orphaned_afk_domains} identity-free AFK rows carry a domain"
    )

    if check_overlaps:
        overlaps = conn.execute(
            "SELECT COUNT(*) FROM sessions a JOIN sessions b ON a.id < b.id"
            " WHERE a.end_ts > a.start_ts AND b.end_ts > b.start_ts"
            " AND a.start_ts < b.end_ts AND b.start_ts < a.end_ts"
        ).fetchone()[0]
        assert overlaps == 0, f"{overlaps} overlapping row pairs"


def test_contract_normal_clock_with_pauses(tmp_path):
    for seed in range(8):
        conn = db.open_db(tmp_path / f"walk_a_{seed}.db")
        try:
            _run_walk(conn, seed, 1500, clock_setbacks=False, pauses=True)
            _assert_invariants(conn, check_overlaps=True)
            assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] > 0
        finally:
            conn.close()


def test_contract_clock_setbacks(tmp_path):
    for seed in range(8):
        conn = db.open_db(tmp_path / f"walk_b_{seed}.db")
        try:
            _run_walk(conn, seed + 100, 1500, clock_setbacks=True, pauses=False)
            _assert_invariants(conn, check_overlaps=True)
        finally:
            conn.close()


def test_contract_everything_at_once(tmp_path):
    """Set-backs + pauses together."""
    for seed in range(8):
        conn = db.open_db(tmp_path / f"walk_c_{seed}.db")
        try:
            _run_walk(conn, seed + 200, 1500, clock_setbacks=True, pauses=True)
            _assert_invariants(conn, check_overlaps=True)
        finally:
            conn.close()


@pytest.mark.parametrize("restart_at,idle,paused", [
    (1301, 301, False), (5000, 4000, False),
    (900, 400, False), (900, 0, False), (900, 400, True),
])
def test_restart_never_overlaps_saved_history_or_records_the_stopped_gap(
    tmp_path, restart_at, idle, paused,
):
    conn = db.open_db(tmp_path / "restart.db")
    try:
        first = SessionManager(db.SqliteStore(conn), Settings())
        first.tick(Snapshot(1000, 0, "editor.exe", "work"))
        first.tick(Snapshot(1299, 299, "editor.exe", "work"))
        # A crash has no shutdown callback; the persisted heartbeat is enough.
        for _ in range(2):
            previous_end = db.latest_session_end(conn)
            manager = SessionManager(
                db.SqliteStore(conn), Settings(tracking_paused=paused),
                recording_floor=previous_end,
            )
            manager.tick(Snapshot(restart_at, idle, "editor.exe", "work"))
            if paused:
                manager.settings = replace(manager.settings, tracking_paused=False)
                restart_at += 1
                manager.tick(Snapshot(restart_at, idle + 1, "editor.exe", "work"))
            row = conn.execute("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").fetchone()
            assert row["start_ts"] >= max(restart_at, previous_end)
            manager.shutdown(max(restart_at + 1, previous_end))
            restart_at += 2
        assert conn.execute(
            "SELECT COUNT(*) FROM sessions a JOIN sessions b ON a.id < b.id"
            " WHERE a.start_ts < b.end_ts AND b.start_ts < a.end_ts"
            " AND a.end_ts > a.start_ts AND b.end_ts > b.start_ts"
        ).fetchone()[0] == 0
    finally:
        conn.close()

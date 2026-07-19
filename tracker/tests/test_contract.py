"""Cross-half contract test (audit TEST-002).

Drives SessionManager with randomized snapshot sequences — sleep gaps, clock
jitter, debounce storms, AFK cycles, pauses — against the *real* SqliteStore on
a temp DB, then asserts the global invariants the dashboard relies on:

  1. end_ts >= start_ts for every row (negative durations are silently dropped
     by the dashboard's clipSessions — they must never be written).
  2. AFK rows never carry a domain.
  3. Non-AFK rows never overlap each other (half-open interval semantics).

Deterministic: fixed seeds, no wall clock. This test caught the open-path
clock-set-back overlap the _floor_ts clamp in session_manager now prevents.
"""

from __future__ import annotations

import random

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

    afk_domains = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE is_afk = 1 AND domain IS NOT NULL"
    ).fetchone()[0]
    assert afk_domains == 0, f"{afk_domains} AFK rows carry a domain"

    if check_overlaps:
        overlaps = conn.execute(
            "SELECT COUNT(*) FROM sessions a JOIN sessions b ON a.id < b.id"
            " WHERE a.is_afk = 0 AND b.is_afk = 0"
            " AND a.start_ts < b.end_ts AND b.start_ts < a.end_ts"
        ).fetchone()[0]
        assert overlaps == 0, f"{overlaps} overlapping non-AFK row pairs"


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

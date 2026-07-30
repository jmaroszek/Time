from tracker import config, db, tracker


def _forbid_background_components(monkeypatch) -> None:
    def unexpected(*_args, **_kwargs):
        raise AssertionError("maintenance startup launched a background component")

    monkeypatch.setattr(
        tracker.media_playback,
        "start_media_playback_monitor",
        unexpected,
    )
    monkeypatch.setattr(
        tracker.power_events,
        "start_power_event_monitor",
        unexpected,
    )
    monkeypatch.setattr(tracker.tray, "start_tray", unexpected)


def test_migration_only_bootstraps_and_exits_without_recording(tmp_path, monkeypatch):
    path = tmp_path / "migration-only.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setenv("TIME_MIGRATE_ONLY", "1")
    _forbid_background_components(monkeypatch)

    tracker.run()

    conn = db.open_db(path)
    try:
        raw = db.read_settings_raw(conn)
        assert raw["schema_version"] == str(db.SCHEMA_VERSION)
        assert raw["tracker_version"] == config.TRACKER_VERSION
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    finally:
        conn.close()


def test_fresh_database_without_consent_exits_before_recording(tmp_path, monkeypatch):
    path = tmp_path / "no-consent.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.delenv("TIME_MIGRATE_ONLY", raising=False)
    _forbid_background_components(monkeypatch)

    tracker.run()

    conn = db.open_db(path)
    try:
        raw = db.read_settings_raw(conn)
        assert raw["recording_consent"] == "0"
        assert raw["privacy_onboarding_complete"] == "0"
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    finally:
        conn.close()

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
    monkeypatch.setattr(tracker.tray, "create_tray_controller", unexpected)


def test_tray_sync_keeps_visibility_separate_from_pause_state():
    class FakeController:
        def __init__(self):
            self.enabled = []
            self.states = []

        def set_enabled(self, enabled):
            self.enabled.append(enabled)
            return enabled

        def sync_state(self, paused, until):
            self.states.append((paused, until))

    controller = FakeController()
    visible = tracker._sync_tray(
        controller,
        {
            "show_tray_icon": "0",
            "tracking_paused": "0",
            "tracking_paused_until": "2000",
        },
        now=1_000,
    )

    assert visible is False
    assert controller.enabled == [False]
    assert controller.states == [(True, 2_000)]
    assert tracker._sync_tray(None, {}, now=1_000) is False


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

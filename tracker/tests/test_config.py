import importlib
import sys

from tracker import config


def _reload_with(monkeypatch, *, frozen: bool, mutex: str | None):
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    if mutex is None:
        monkeypatch.delenv("TIME_MUTEX_NAME", raising=False)
    else:
        monkeypatch.setenv("TIME_MUTEX_NAME", mutex)
    return importlib.reload(config)


def test_packaged_build_honours_the_mutex_override(monkeypatch):
    """The packaged smoke starts a second tracker while the live one still holds
    the production mutex. Exempting frozen builds from the override sent that
    run down the duplicate-instance path, where it exits 0 without recording —
    a green smoke that proved nothing."""
    try:
        reloaded = _reload_with(monkeypatch, frozen=True, mutex="Global\\TimeSmoke")
        assert reloaded.MUTEX_NAME == "Global\\TimeSmoke"
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_the_production_mutex_is_the_default_for_every_build(monkeypatch):
    try:
        for frozen in (True, False):
            reloaded = _reload_with(monkeypatch, frozen=frozen, mutex=None)
            assert reloaded.MUTEX_NAME == "Global\\TimeTrackerSingleton"
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_a_packaged_build_still_refuses_to_be_relocated_by_the_environment(
    monkeypatch, tmp_path
):
    """TIME_DATA_DIR moves the database; TIME_MUTEX_NAME only allows a second
    instance. The smoke redirects LOCALAPPDATA instead, so a frozen build must
    keep ignoring the data-dir override even though it now honours the mutex."""
    try:
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setenv("TIME_DATA_DIR", str(tmp_path / "elsewhere"))
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "scratch"))
        reloaded = importlib.reload(config)
        assert reloaded.DATA_DIR == tmp_path / "scratch" / "Time"
    finally:
        monkeypatch.undo()
        importlib.reload(config)

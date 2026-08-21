from tracker import win32_probe


def _set_last_input(monkeypatch, *, now_ms: int, last_ms: int) -> None:
    def get_last_input(pointer):
        pointer._obj.dwTime = last_ms
        return True

    monkeypatch.setattr(win32_probe._user32, "GetLastInputInfo", get_last_input)
    monkeypatch.setattr(win32_probe._kernel32, "GetTickCount64", lambda: now_ms)


def test_idle_seconds_uses_64_bit_tick_count(monkeypatch):
    _set_last_input(monkeypatch, now_ms=20_500, last_ms=18_000)

    assert win32_probe.get_idle_seconds() == 2.5


def test_idle_seconds_handles_last_input_counter_wraparound(monkeypatch):
    _set_last_input(
        monkeypatch,
        now_ms=0x1_0000_0200,
        last_ms=0xFFFF_FE00,
    )

    assert win32_probe.get_idle_seconds() == 1.024


def test_process_name_cache_distinguishes_pid_reuse_by_creation_time(monkeypatch):
    win32_probe._name_cache.clear()
    state = {"name": "old.exe", "created": 100.0}

    class FakeProcess:
        def name(self):
            return state["name"]

        def create_time(self):
            return state["created"]

    monkeypatch.setattr(win32_probe.psutil, "Process", lambda _pid: FakeProcess())

    assert win32_probe._proc_name(42) == "old.exe"
    state.update(name="new.exe", created=200.0)
    assert win32_probe._proc_name(42) == "new.exe"
    assert set(win32_probe._name_cache) == {(42, 100.0), (42, 200.0)}


def test_app_user_model_id_cache_distinguishes_pid_reuse_by_creation_time(monkeypatch):
    win32_probe._app_id_cache.clear()
    state = {"created": 100.0, "app_id": "Old.App"}

    class FakeKernel:
        def OpenProcess(self, *_args):
            return 1

        def GetApplicationUserModelId(self, _handle, length, buffer):
            if buffer is None:
                length._obj.value = len(state["app_id"]) + 1
                return win32_probe._ERROR_INSUFFICIENT_BUFFER
            buffer.value = state["app_id"]
            return 0

        def CloseHandle(self, _handle):
            return True

    monkeypatch.setattr(win32_probe, "_kernel32", FakeKernel())
    monkeypatch.setattr(
        win32_probe,
        "_process_cache_key",
        lambda pid: (pid, state["created"]),
    )

    assert win32_probe._proc_app_user_model_id(42) == "Old.App"
    state.update(created=200.0, app_id="New.App")
    assert win32_probe._proc_app_user_model_id(42) == "New.App"
    assert set(win32_probe._app_id_cache) == {(42, 100.0), (42, 200.0)}


def test_resolve_uwp_pid_ignores_application_frame_host(monkeypatch):
    process_ids = {100: 41, 101: 99}

    def enum_children(_hwnd, callback, arg):
        for child in process_ids:
            if not callback(child, arg):
                break

    monkeypatch.setattr(win32_probe.win32gui, "EnumChildWindows", enum_children)
    monkeypatch.setattr(
        win32_probe.win32process,
        "GetWindowThreadProcessId",
        lambda hwnd: (1, process_ids[hwnd]),
    )

    assert win32_probe._resolve_uwp_pid(7, 41) == 99


def test_snapshot_uses_uwp_child_identity_and_sanitizes_title(monkeypatch):
    monkeypatch.setattr(win32_probe, "get_idle_seconds", lambda: 3.25)
    monkeypatch.setattr(win32_probe.win32gui, "GetForegroundWindow", lambda: 44)
    monkeypatch.setattr(
        win32_probe.win32process,
        "GetWindowThreadProcessId",
        lambda _hwnd: (1, 900),
    )
    monkeypatch.setattr(
        win32_probe.win32gui,
        "GetWindowText",
        lambda _hwnd: "A\x00" + ("b" * 600),
    )
    monkeypatch.setattr(
        win32_probe,
        "_proc_name",
        lambda pid: {
            900: win32_probe._UWP_HOST,
            901: "calculatorapp.exe",
        }[pid],
    )
    monkeypatch.setattr(win32_probe, "_resolve_uwp_pid", lambda _hwnd, _pid: 901)
    monkeypatch.setattr(
        win32_probe,
        "_proc_app_user_model_id",
        lambda pid: f"app:{pid}",
    )

    result = win32_probe.snapshot(123.0)

    assert result.now == 123.0
    assert result.idle_seconds == 3.25
    assert result.process == "calculatorapp.exe"
    assert result.app_user_model_id == "app:901"
    assert "\x00" not in result.title
    assert len(result.title) == 512


def test_snapshot_returns_no_identity_without_foreground_window(monkeypatch):
    monkeypatch.setattr(win32_probe, "get_idle_seconds", lambda: 1.0)
    monkeypatch.setattr(win32_probe.win32gui, "GetForegroundWindow", lambda: 0)

    result = win32_probe.snapshot(10.0)

    assert result.process is None
    assert result.title == ""
    assert result.app_user_model_id is None

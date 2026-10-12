"""Native tests drive the real recorder through a separate scratch DB connection.

No foreground probes, tray, autostart, or default profile paths are used.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tracker import db
from tracker.session_manager import SessionManager, Snapshot


def main():
    path = Path(sys.argv[1]).resolve(strict=True)
    if "test-scratch" not in path.parts:
        raise ValueError("interop worker requires a native test-scratch database")
    conn = db.open_db(path)
    manager = SessionManager(db.SqliteStore(conn), db.get_settings(conn),
                             recording_floor=db.latest_session_end(conn))
    print(json.dumps({"ready": True}), flush=True)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("shutdown"):
                manager.shutdown(request["now"])
            else:
                if request.get("refresh", True):
                    manager.settings = db.get_settings(conn, request["now"])
                manager.tick(Snapshot(request["now"], request.get("idle", 0),
                                      request.get("process", "editor.exe"), request.get("title", "")))
            print(json.dumps([dict(row) for row in conn.execute("SELECT * FROM sessions ORDER BY id")]), flush=True)
            if request.get("shutdown"):
                break
    finally:
        conn.close()


if __name__ == "__main__":
    main()

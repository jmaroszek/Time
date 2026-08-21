"""Print the GSMTC source id of every current media session.

Run while media is actually playing. The source id is matched against the
foreground process name or AUMID; live captures have observed both desktop
player identifiers and browser identifiers (for example, ``MSEdge`` and
``Chrome``). Browser playback still needs the foreground browser's known media
domain before it can protect an idle interval.
"""

import asyncio

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
)


async def main() -> None:
    manager = await Manager.request_async()
    sessions = manager.get_sessions()
    if not sessions:
        print("No media sessions reported.")
        return
    for session in sessions:
        try:
            playing = session.get_playback_info().playback_status == Status.PLAYING
        except Exception as exc:
            playing = f"<unreadable: {type(exc).__name__}>"
        print(f"source_app_user_model_id = {session.source_app_user_model_id!r}   playing={playing}")


if __name__ == "__main__":
    asyncio.run(main())

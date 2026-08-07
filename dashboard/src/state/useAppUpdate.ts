// Owns the update check and the install it can lead to. The decision rules are
// in lib/appUpdate.ts so they can be tested without a renderer; what is left
// here is when to ask and what to do with the answer.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkForUpdate,
  installUpdate,
  readLastUpdateCheck,
  shouldCheckForUpdates,
  writeLastUpdateCheck,
  UPDATE_PROGRESS_EVENT,
  type AvailableUpdate,
  type UpdateProgress,
} from "../lib/appUpdate";

export interface AppUpdateState {
  /** The waiting version, or null when there is none and when the check could
   *  not be made — the two are deliberately indistinguishable here. */
  available: AvailableUpdate | null;
  installing: boolean;
  progress: UpdateProgress | null;
  install: () => void;
}

export function useAppUpdate(
  settings: Record<string, string>,
  ready: boolean,
  onError: (error: unknown) => void,
): AppUpdateState {
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  // Settings arrive as a fresh object on every refresh, and a write anywhere in
  // the app produces one. Without this the check would fire again on each.
  const asked = useRef(false);

  useEffect(() => {
    if (!ready || asked.current) return;
    if (!shouldCheckForUpdates(settings, readLastUpdateCheck(), Date.now())) return;
    asked.current = true;
    void checkForUpdate()
      .then((update) => {
        // Stamped even when the answer was "nothing", including the nothing a
        // failed request produces: a machine that is offline at launch should
        // not retry on every window it opens.
        writeLastUpdateCheck(Date.now());
        setAvailable(update);
      })
      .catch(() => {});
  }, [ready, settings]);

  // Imported lazily so a renderer running outside Tauri — the device fixture,
  // a plain vite dev server — never loads the event bridge at all.
  useEffect(() => {
    const subscription = import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (event) => setProgress(event.payload)),
      )
      .catch(() => null);
    return () => {
      void subscription.then((unlisten) => unlisten?.());
    };
  }, []);

  const install = useCallback(() => {
    if (installing) return;
    setInstalling(true);
    setProgress(null);
    // Only the failure path returns: a successful install exits this process
    // from inside the NSIS package, so there is no success branch to write.
    void installUpdate().catch((error: unknown) => {
      setInstalling(false);
      setProgress(null);
      onError(error);
    });
  }, [installing, onError]);

  return { available, installing, progress, install };
}

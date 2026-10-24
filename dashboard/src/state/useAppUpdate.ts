// Owns the update check and the install it can lead to. The decision rules are
// in lib/appUpdate.ts so they can be tested without a renderer; what is left
// here is when to ask and what to do with the answer.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkForUpdate,
  checkForUpdateNow,
  forgetLegacyUpdateCheck,
  installUpdate,
  shouldCheckForUpdates,
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
  /** Where the check asked for from Settings stands; "idle" until it is used. */
  manualCheck: ManualUpdateCheck;
  checkNow: () => void;
}

export type ManualUpdateCheck = "idle" | "checking" | "current" | "available" | "failed";

export function useAppUpdate(
  settings: Record<string, string>,
  ready: boolean,
  onError: (error: unknown) => void,
): AppUpdateState {
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [manualCheck, setManualCheck] = useState<ManualUpdateCheck>("idle");
  // Once per launch. Settings arrive as a fresh object on every refresh, and a
  // write anywhere in the app produces one; without this the check would fire
  // again on each. Closing the window ends the process, so the next open is a
  // new launch and asks again.
  const asked = useRef(false);

  useEffect(() => {
    if (!ready || asked.current) return;
    if (!shouldCheckForUpdates(settings)) return;
    asked.current = true;
    forgetLegacyUpdateCheck();
    void checkForUpdate()
      .then(setAvailable)
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

  // Asked for, so it runs whether or not automatic checks are on: that switch
  // is about Time reaching out unprompted, and pressing the button is consent.
  const checkNow = useCallback(() => {
    if (manualCheck === "checking") return;
    setManualCheck("checking");
    void checkForUpdateNow()
      .then((update) => {
        setAvailable(update);
        setManualCheck(update ? "available" : "current");
      })
      .catch(() => setManualCheck("failed"));
  }, [manualCheck]);

  return { available, installing, progress, install, manualCheck, checkNow };
}

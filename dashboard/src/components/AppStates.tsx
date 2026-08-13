import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  PUBLISHED_TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_NAME,
  isPublished,
  listingForProgId,
  openExtensionStorePage,
  storeGateForProgId,
  type TimeExtensionListing,
} from "../lib/browserExtensions";
import { getDbPath } from "../lib/db";
import {
  deleteCategory,
  updateSetting,
  type TrackerStatus,
} from "../lib/queries";
import { useBanner } from "../state/banner";
import { useMeta } from "../state/meta";
import { Button, Checkbox } from "./ui";

const TRACKER_CONFIRM_MS = 25_000;

export function PrivacyOnboarding() {
  const meta = useMeta();
  const [windowTitles, setWindowTitles] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(true);
  const [startWithEssentials, setStartWithEssentials] = useState(true);
  const [installExtension, setInstallExtension] = useState(true);
  const [extensionListing, setExtensionListing] = useState<
    TimeExtensionListing | null | undefined
  >(undefined);
  const [storeGate, setStoreGate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<string | null>("default_browser_prog_id")
      .catch(() => null)
      .then((progId) => {
        if (cancelled) return;
        setExtensionListing(
          listingForProgId(progId) ?? PUBLISHED_TIME_EXTENSION_LISTINGS[0] ?? null,
        );
        setStoreGate(storeGateForProgId(progId));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const complete = async (enable: boolean) => {
    setSaving(true);
    setError(null);
    try {
      if (meta.settings.starter_categories_pending === "1") {
        if (!startWithEssentials) {
          const starterNames = new Set([
            "Work",
            "Communication",
            "Browsing",
            "Entertainment",
            "System",
          ]);
          for (const category of meta.categories) {
            if (starterNames.has(category.name)) await deleteCategory(category.id);
          }
        }
        await updateSetting("starter_categories_pending", "0");
      }
      await updateSetting("record_window_titles", enable && windowTitles ? "1" : "0");
      await updateSetting("launch_at_login", enable && startAtLogin ? "1" : "0");
      await updateSetting("recording_consent", enable ? "1" : "0");
      await invoke("set_launch_at_login", { enabled: enable && startAtLogin });
      if (enable) await invoke("start_tracker");
      await updateSetting("privacy_onboarding_complete", "1");
      if (enable && installExtension && extensionListing && isPublished(extensionListing)) {
        await openExtensionStorePage(extensionListing).catch(() => {});
      }
      await meta.refresh();
    } catch (cause) {
      // A partial first-run transaction must always fail closed.
      await updateSetting("recording_consent", "0").catch(() => {});
      await updateSetting("launch_at_login", "0").catch(() => {});
      await invoke("set_launch_at_login", { enabled: false }).catch(() => {});
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-3 sm:p-8">
      <section className="scroll-well max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-[18px] border border-edge bg-surface px-4 py-5 shadow-panel sm:max-h-[calc(100dvh-4rem)] sm:px-7 sm:py-6">
        <p className="text-micro font-bold uppercase tracking-[.12em] text-accent">Private by design</p>
        <h1 className="mt-2 text-lg font-semibold text-ink">Choose what Time can record</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          Time has no accounts, servers, or telemetry. All activity is recorded and analyzed
          locally. Your data stays yours forever.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div className="rounded-xl border border-edge bg-surface-dim p-4">
            <p className="font-medium">When tracking is enabled</p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
              Time tracks app use by default. Website tracking requires the optional Time Web
              Extension.
            </p>
          </div>
          <ConsentCheck
            checked={startAtLogin}
            onChange={setStartAtLogin}
            title="Start the tracker when I sign in"
            detail="Runs only for this Windows account. You can disable tracking and startup later in Settings."
          />
          {meta.settings.starter_categories_pending === "1" && (
            <ConsentCheck
              checked={startWithEssentials}
              onChange={setStartWithEssentials}
              title="Start with essential categories"
              detail="Adds Work, Communication, Browsing, Entertainment, and System without classifying any apps or sites. You can rename, change, or delete them later."
            />
          )}
          {extensionListing !== undefined && extensionListing !== null && (
            isPublished(extensionListing) ? (
              <ConsentCheck
                checked={installExtension}
                onChange={setInstallExtension}
                title={`Install ${TIME_EXTENSION_NAME}`}
                detail={`Splits browser time by website instead of logging one long session in Chrome, Firefox, or another browser. If you accept, the app will open the web store listing for your browser after this screen.${storeGate === null ? "" : ` ${storeGate}`}`}
              />
            ) : (
              <div className="rounded-xl border border-edge bg-surface-dim p-4">
                <p className="font-medium text-ink">
                  {TIME_EXTENSION_NAME} for {extensionListing.browsers}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-3">
                  Coming soon to the {extensionListing.store}. Time still records{" "}
                  {extensionListing.browsers} as an app in the meantime, and Settings will carry
                  the link once it is published.
                </p>
              </div>
            )
          )}
          <ConsentCheck
            checked={windowTitles}
            onChange={setWindowTitles}
            title="Store window titles"
            detail="Storing window titles lets you create rules that classify activity differently within the same app. Titles may include document names, email subjects, or other sensitive text, so this setting is off by default. You can still create app and website rules without window titles."
          />
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => void complete(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving…" : "Start tracking"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void complete(false)}
            className="rounded-lg border border-edge-2 px-4 py-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50"
          >
            Not now
          </button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Choosing “Not now” opens the dashboard without starting or registering the tracker.
        </p>
      </section>
    </div>
  );
}

function ConsentCheck({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  detail: string;
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      size="md"
      align="start"
      className="gap-3 rounded-xl border border-edge bg-surface-dim p-4"
    >
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">{detail}</span>
      </span>
    </Checkbox>
  );
}

export function FirstRunPanel({
  status,
  onRefreshStatus,
  onOpenSettings,
}: {
  status: TrackerStatus;
  onRefreshStatus: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const meta = useMeta();
  const banner = useBanner();
  const [starting, setStarting] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [offerStartup, setOfferStartup] = useState(false);
  const [startAttempted, setStartAttempted] = useState(false);
  const [startUnconfirmed, setStartUnconfirmed] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const heartbeatAge = status.lastHeartbeat == null
    ? null
    : Date.now() / 1000 - status.lastHeartbeat;
  const trackerLive = heartbeatAge !== null && heartbeatAge < 120;

  const startTracking = async () => {
    const needsStartup = meta.settings.launch_at_login !== "1";
    setStarting(true);
    try {
      await updateSetting("recording_consent", "1");
      await invoke("start_tracker");
      await Promise.all([meta.refresh(), onRefreshStatus()]);
      setStartAttempted(true);
      if (needsStartup) setOfferStartup(true);
    } catch (cause) {
      banner.report(cause, "tracker startup");
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!startAttempted) return;
    if (trackerLive) {
      setStartUnconfirmed(false);
      setStartAttempted(false);
      return;
    }
    const id = setTimeout(() => setStartUnconfirmed(true), TRACKER_CONFIRM_MS);
    return () => clearTimeout(id);
  }, [startAttempted, trackerLive]);

  // Dismissal is the only thing that retires this panel, so it has to persist.
  // A component-local flag would bring the whole thing back on the next launch,
  // which reads as the app having forgotten the reader rather than respecting
  // them. Deliberately outside DEFAULT_USER_SETTINGS: restoring default
  // settings should not resurrect a welcome the reader already read.
  const dismiss = async () => {
    setDismissing(true);
    try {
      await updateSetting("welcome_dismissed", "1");
      await meta.refresh();
    } catch (cause) {
      banner.report(cause, "dismissing the welcome panel");
      setDismissing(false);
    }
  };

  const enableStartup = async () => {
    setRegistering(true);
    try {
      await updateSetting("launch_at_login", "1");
      await invoke("set_launch_at_login", { enabled: true });
      await meta.refresh();
      setOfferStartup(false);
    } catch (cause) {
      banner.report(cause, "startup registration");
    } finally {
      setRegistering(false);
    }
  };

  return (
    <section className="rounded-[14px] border border-accent/25 bg-gradient-to-b from-accent/[.06] to-accent/[.02] px-5 py-4 text-xs leading-relaxed">
      <div className="flex items-start justify-between gap-3">
        <p className="text-row font-semibold">Welcome to Time</p>
        {/* Only once tracking is on. While it is stopped this panel is not a
            welcome but the readiest way to start recording — and, after "Not
            now" on the privacy screen, the only one outside Settings. */}
        {trackerLive && (
          <Button onClick={() => void dismiss()} disabled={dismissing}>
            {dismissing ? "Saving…" : "Got it"}
          </Button>
        )}
      </div>
      {trackerLive ? (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-ink-2">
            <span className="h-2 w-2 rounded-full bg-good-data" />
            Tracking is on.
          </p>
          <div className="mt-3 space-y-2 text-ink-2">
            <p>
              <span className="font-medium text-ink">Keep using your computer normally.</span>{" "}
              Time records in the background. There is nothing to start or stop.
            </p>
            <p>
              <span className="font-medium text-ink">Check back tomorrow.</span> The Activity tab
              will have a list of the apps and websites you have used, waiting to be sorted into
              categories. That is what turns recorded time into the numbers on this page.
            </p>
            <p>
              <span className="font-medium text-ink">Time updates on focus.</span> Switch to
              another app and back to pull in the latest data. You can also do the same with tabs
              within Time.
            </p>
          </div>
          {offerStartup && (
            <div className="mt-3 rounded-[10px] border border-edge bg-surface-2/60 px-3 py-2.5">
              <p className="text-ink-2">
                Time won&rsquo;t come back on its own after you shut down. Start it automatically
                when you sign in?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={registering}
                  onClick={() => void enableStartup()}
                >
                  {registering ? "Saving…" : "Start at sign-in"}
                </Button>
                <Button onClick={() => setOfferStartup(false)}>Not now</Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-ink-2">
            <span className="h-2 w-2 rounded-full bg-bad" />
            The tracker isn&rsquo;t running, so nothing is being recorded.
          </p>
          <p className="mt-1 text-ink-2">
            Start tracking when you&rsquo;re ready, or review your settings first.
          </p>
          {startUnconfirmed && (
            <p className="mt-2 text-bad">
              Time couldn&rsquo;t confirm the tracker started. Open Settings to check its status.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={starting} onClick={() => void startTracking()}>
              {starting ? "Starting…" : "Start tracking"}
            </Button>
            <Button onClick={onOpenSettings}>Open settings</Button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Recording is on and the tracker is not answering.
 *
 * This is the one tracker state worth interrupting for, because it is the only
 * one with no symptom. A paused or descheduled tracker was the reader's own
 * decision; a dead one looks exactly like a quiet day — the numbers simply stop
 * growing, and nothing distinguishes that from not having used the computer.
 * Until now it was reported only in Settings, which is the last place someone
 * goes when they have no reason to suspect a problem.
 */
export function TrackerAlert({ onOpenSettings }: { onOpenSettings: () => void }) {
  const banner = useBanner();
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      await invoke("start_tracker");
    } catch (cause) {
      banner.report(cause, "tracker startup");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="rounded-[14px] border border-bad/30 bg-bad/10 px-5 py-4 text-xs leading-relaxed">
      <p className="flex flex-wrap items-center gap-2 text-row font-semibold">
        <span className="h-2 w-2 rounded-full bg-bad" />
        Time has stopped recording
      </p>
      <p className="mt-2 text-ink-2">
        Tracking is switched on, but the tracker is not running. No activity is being recorded
        until it starts again.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Start tracking"}
        </Button>
        <Button onClick={onOpenSettings}>Open settings</Button>
      </div>
    </section>
  );
}

function DbPathFooter() {
  return <p className="mt-3 break-all font-mono text-xs text-ink-3">{getDbPath()}</p>;
}

export function WaitingForTracker() {
  return (
    <div className="flex h-full min-h-80 items-center justify-center p-10">
      <div className="max-w-md text-sm">
        <p className="font-semibold">Waiting for the tracker&apos;s first data</p>
        <p className="mt-2 text-ink-2">
          Time&apos;s tracker creates the database the first time it runs. Start the tracker and
          this screen will update by itself within a few seconds.
        </p>
        <DbPathFooter />
      </div>
    </div>
  );
}

export function NewerDatabaseScreen() {
  return (
    <div className="p-10 text-sm">
      <p className="font-semibold">This database needs a newer version of Time</p>
      <p className="mt-2 max-w-md text-ink-2">
        Your data was created by a newer Time release than this dashboard supports. Update Time
        and open it again. This version has not changed the database.
      </p>
      <DbPathFooter />
    </div>
  );
}

export function DbErrorScreen({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="p-10 text-sm">
      <p className="font-semibold text-bad">Time couldn&apos;t read its database</p>
      <p className="mt-2 max-w-md text-ink-2">
        If you just installed, make sure the tracker has started — it creates the database on
        first run. Otherwise the file below may be locked or unreadable.
      </p>
      <DbPathFooter />
      <button
        type="button"
        className="mt-4 rounded-lg border border-edge-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
        onClick={() =>
          void navigator.clipboard.writeText(error).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy error details"}
      </button>
      {import.meta.env.DEV && (
        <p className="mt-4 max-w-xl break-all text-xs text-ink-3">
          {error} — check TIME_DB_PATH / src/lib/db.ts (debug-only hint).
        </p>
      )}
    </div>
  );
}

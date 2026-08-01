// The "URL in title" extensions that let Time tell one website from another.
//
// Time reads the domain out of the browser's window title (tracker/domains.py),
// which is only possible when an extension puts the web address there. Without
// one, a whole day of browsing collapses into a single undivided block under
// the browser's own name.
//
// Only the Chrome extension has been vetted. Adding a browser means adding an
// entry here *and* its store origin to the `opener:allow-open-url` scope in
// src-tauri/capabilities/default.json. The scope is a static allowlist that
// cannot be derived from this file, and a missing origin fails at the moment a
// user clicks the link rather than at build time.

import { openUrl } from "@tauri-apps/plugin-opener";

export type UrlInTitleExtension = {
  /** Browser name as a reader would say it. */
  browser: string;
  /** Processes that identify this browser, as stored in `browser_processes`. */
  processes: readonly string[];
  /** Extension name exactly as its store lists it. */
  name: string;
  storeUrl: string;
};

export const URL_IN_TITLE_EXTENSIONS: readonly UrlInTitleExtension[] = [
  {
    browser: "Chrome",
    processes: ["chrome.exe"],
    name: "URL in Title",
    storeUrl:
      "https://chromewebstore.google.com/detail/url-in-title/ignpacbgnbnkaiooknalneoeladjnfgb",
  },
];

/** Open an extension's store page in the user's default browser. */
export async function openExtensionStorePage(
  extension: UrlInTitleExtension,
): Promise<void> {
  await openUrl(extension.storeUrl);
}

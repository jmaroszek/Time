// First-party Time Web Extension listings. Store pages do not exist
// until their owners publish the separately versioned extension packages, so
// an unpublished listing has no URL and the UI cannot open a placeholder.
// When a URL is supplied here, its origin must already be present in
// src-tauri/capabilities/default.json's static opener allowlist.

import { openUrl } from "@tauri-apps/plugin-opener";

export type TimeExtensionListing = {
  /** Browsers served by this store package, in reader-facing language. */
  browsers: string;
  /** Processes covered by this package and Time's browser setting. */
  processes: readonly string[];
  /** Store name as shown to the user. */
  store: string;
  /** Stable first-party listing URL; null until that listing is published. */
  storeUrl: string | null;
};

export type PublishedTimeExtensionListing = TimeExtensionListing & {
  storeUrl: string;
};

export const TIME_EXTENSION_NAME = "Time Web Extension";

export const TIME_EXTENSION_LISTINGS: readonly TimeExtensionListing[] = [
  {
    browsers: "Chrome, Brave, and Opera",
    processes: ["chrome.exe", "brave.exe", "opera.exe"],
    store: "Chrome Web Store",
    storeUrl: null,
  },
  {
    browsers: "Edge",
    processes: ["msedge.exe"],
    store: "Microsoft Edge Add-ons",
    storeUrl: null,
  },
  {
    browsers: "Firefox",
    processes: ["firefox.exe"],
    store: "Firefox Add-ons",
    storeUrl: null,
  },
];

function isPublished(
  listing: TimeExtensionListing,
): listing is PublishedTimeExtensionListing {
  return listing.storeUrl !== null;
}

export const PUBLISHED_TIME_EXTENSION_LISTINGS =
  TIME_EXTENSION_LISTINGS.filter(isPublished);

/** Open one published first-party listing in the user's default browser. */
export async function openExtensionStorePage(
  listing: PublishedTimeExtensionListing,
): Promise<void> {
  await openUrl(listing.storeUrl);
}

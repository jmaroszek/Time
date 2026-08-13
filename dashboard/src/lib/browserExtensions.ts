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
    browsers: "Chrome, Brave, Opera, and Vivaldi",
    processes: ["chrome.exe", "brave.exe", "opera.exe", "vivaldi.exe"],
    store: "Chrome Web Store",
    storeUrl:
      "https://chromewebstore.google.com/detail/time-web-extension/gnlfnddpjedjehaeofdbpfmmjghieoke",
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
    // Locale-less path on purpose: AMO redirects it to the reader's own locale,
    // where the "en-US" listing URL would pin every reader to English.
    storeUrl: "https://addons.mozilla.org/firefox/addon/time-web-extension/",
  },
];

export function isPublished(
  listing: TimeExtensionListing,
): listing is PublishedTimeExtensionListing {
  return listing.storeUrl !== null;
}

export const PUBLISHED_TIME_EXTENSION_LISTINGS =
  TIME_EXTENSION_LISTINGS.filter(isPublished);

type ProgIdRoute = {
  /** Matched against the ProgId's start, not the whole value. */
  prefix: string;
  store: string;
  /** What this browser puts between the store page and an installed
   *  extension, when it puts anything there at all. A reader who is not
   *  warned reads the extra step as Time having sent them somewhere wrong. */
  gate?: string;
};

// Windows names the https handler by ProgId, which is how Time learns which
// store to offer without asking. Firefox and its forks append an
// install-specific suffix -- "FirefoxURL-308046B0AF4A39CB" -- so these match by
// prefix, case-insensitively, rather than by equality.
const PROG_ID_ROUTES: readonly ProgIdRoute[] = [
  { prefix: "ChromeHTML", store: "Chrome Web Store" },
  {
    prefix: "MSEdgeHTM",
    store: "Chrome Web Store",
    // Phrased without "if you use Edge": a gate is only ever rendered to the
    // browser it belongs to, so the condition is already established.
    gate: "You may need to enable extensions from other stores in Edge first.",
  },
  { prefix: "BraveHTML", store: "Chrome Web Store" },
  {
    prefix: "OperaStable",
    store: "Chrome Web Store",
    // A harder gate than Edge's: Opera cannot install from this store at all
    // until its own add-on is in place, so the store page alone is a dead end.
    gate: "Opera installs from this store only after you add its own “Install Chrome Extensions” add-on first.",
  },
  { prefix: "VivaldiHTM", store: "Chrome Web Store" },
  { prefix: "ChromiumHTM", store: "Chrome Web Store" },
  { prefix: "FirefoxURL", store: "Firefox Add-ons" },
];

function routeForProgId(progId: string | null | undefined): ProgIdRoute | null {
  if (!progId) return null;
  const normalized = progId.toLowerCase();
  return (
    PROG_ID_ROUTES.find((route) =>
      normalized.startsWith(route.prefix.toLowerCase()),
    ) ?? null
  );
}

/** The listing serving the browser Windows opens https with, or null when the
 *  ProgId is missing or belongs to a browser Time has no package for.
 *
 *  A returned listing may still be unpublished. Resolving which store *should*
 *  serve a reader is a separate question from whether that store has the
 *  package yet, and collapsing the two would silently offer a Firefox reader
 *  the Chrome listing. */
export function listingForProgId(
  progId: string | null | undefined,
): TimeExtensionListing | null {
  const route = routeForProgId(progId);
  if (route === null) return null;
  return TIME_EXTENSION_LISTINGS.find(({ store }) => store === route.store) ?? null;
}

/** The extra step this browser puts between the store page and an installed
 *  extension, or null when it installs directly. */
export function storeGateForProgId(
  progId: string | null | undefined,
): string | null {
  return routeForProgId(progId)?.gate ?? null;
}

/** Open one published first-party listing in the user's default browser. */
export async function openExtensionStorePage(
  listing: PublishedTimeExtensionListing,
): Promise<void> {
  await openUrl(listing.storeUrl);
}

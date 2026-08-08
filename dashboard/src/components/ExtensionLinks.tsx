import { Button } from "./ui";
import { useBanner } from "../state/banner";
import {
  PUBLISHED_TIME_EXTENSION_LISTINGS,
  TIME_EXTENSION_NAME,
  openExtensionStorePage,
} from "../lib/browserExtensions";

/** First-party store links, or an honest pre-publication state.
 *
 *  Null URLs never become buttons: a placeholder that launches successfully
 *  but cannot install Time would turn a release-metadata gap into a user-facing
 *  failure. Once stores publish their stable URLs, the shared registry makes
 *  the links appear in both Activity and Settings.
 */
export function ExtensionLinks() {
  const banner = useBanner();
  if (PUBLISHED_TIME_EXTENSION_LISTINGS.length === 0) {
    return (
      <p className="text-meta leading-snug text-ink-3">
        {TIME_EXTENSION_NAME} store listings are being prepared.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {PUBLISHED_TIME_EXTENSION_LISTINGS.map((listing) => (
        <Button
          key={listing.storeUrl}
          variant="primary"
          title={`For ${listing.browsers}`}
          onClick={() => {
            void openExtensionStorePage(listing).catch((error) =>
              banner.report(error, "opening the Time extension page"),
            );
          }}
        >
          <span className="flex items-center gap-1.5">
            {listing.store}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6" /><path d="M10 14 21 3" />
            </svg>
          </span>
        </Button>
      ))}
    </div>
  );
}

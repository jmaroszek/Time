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
          Get {TIME_EXTENSION_NAME} from {listing.store}
        </Button>
      ))}
    </div>
  );
}

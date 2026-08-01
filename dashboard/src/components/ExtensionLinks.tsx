import { Button } from "./ui";
import { useBanner } from "../state/banner";
import {
  URL_IN_TITLE_EXTENSIONS,
  openExtensionStorePage,
} from "../lib/browserExtensions";

/** One button per vetted "URL in title" extension.
 *
 *  Renders the whole vetted set rather than taking a browser argument, so
 *  adding an entry to URL_IN_TITLE_EXTENSIONS reaches both the Activity hint
 *  and Settings without either site changing. */
export function ExtensionLinks() {
  const banner = useBanner();
  return (
    <div className="flex flex-wrap gap-2">
      {URL_IN_TITLE_EXTENSIONS.map((extension) => (
        <Button
          key={extension.storeUrl}
          variant="primary"
          onClick={() => {
            void openExtensionStorePage(extension).catch((error) =>
              banner.report(error, "opening the extension page"),
            );
          }}
        >
          Get &ldquo;{extension.name}&rdquo; for {extension.browser}
        </Button>
      ))}
    </div>
  );
}

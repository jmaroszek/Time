// Sites whose playback exempts a browser session from AFK. Time ships knowing
// the mainstream services; this module is the reader's own additions on top of
// them, and the arithmetic that keeps the settings field honest about which of
// the two an entry lands in.
//
// BUILT_IN_MEDIA_SITES mirrors _MEDIA_DOMAINS in tracker/media_playback.py,
// which is the half that actually gates AFK — nothing here changes tracking.
// The copy exists so the field can say "Time already recognizes youtube.com"
// instead of accepting a redundant entry; mediaSites.test.ts compares it
// against the Python source so the two cannot drift.

import { normalizeHost } from "./hostNormalization";

export const BUILT_IN_MEDIA_SITES: readonly string[] = [
  "audible.com",
  "bandcamp.com",
  "crackle.com",
  "crunchyroll.com",
  "dailymotion.com",
  "dazn.com",
  "deezer.com",
  "discoveryplus.com",
  "disneyplus.com",
  "espn.com",
  "foxsports.com",
  "fubo.tv",
  "hbomax.com",
  "hulu.com",
  "iheart.com",
  "iheartradio.com",
  "max.com",
  "mixcloud.com",
  "mlb.com",
  "music.amazon.com",
  "music.apple.com",
  "napster.com",
  "nba.com",
  "netflix.com",
  "nfl.com",
  "pandora.com",
  "paramountplus.com",
  "peacocktv.com",
  "philo.com",
  "plex.tv",
  "pluto.tv",
  "primevideo.com",
  "qobuz.com",
  "roku.com",
  "sling.com",
  "soundcloud.com",
  "spotify.com",
  "tidal.com",
  "tubitv.com",
  "twitch.tv",
  "tv.apple.com",
  "vimeo.com",
  "youtube.com",
];

/** Normalize one typed or pasted site into the host shape sessions store.
 *
 *  Uses the shared host-normalization contract implemented by
 *  tracker/domains.py and hostNormalization.ts. Returns "" for anything that
 *  is not host-shaped once the decoration is gone. */
export function normalizeMediaSite(raw: string): string {
  return normalizeHost(raw) ?? "";
}

/** Normalized, de-duplicated, and order-preserving, so the field reads back the
 *  way it was typed. Accepts commas and newlines, as a paste carries. */
export function normalizeMediaSites(raw: string): string[] {
  const sites: string[] = [];
  for (const part of raw.split(/[,\r\n]/)) {
    const site = normalizeMediaSite(part);
    if (site && !sites.includes(site)) sites.push(site);
  }
  return sites;
}

/** The entry that already protects `site`, or null when nothing does.
 *
 *  Subdomain-aware in the same direction the tracker matches: an entry covers
 *  itself and everything under it, so youtube.com answers for
 *  music.youtube.com. Naming the covering entry rather than the typed one is
 *  what teaches that rule — "Time already recognizes youtube.com" explains a
 *  rejected music.youtube.com in a way repeating the input never could. */
export function coveringMediaSite(
  site: string,
  additions: readonly string[] = [],
): string | null {
  const normalized = normalizeMediaSite(site);
  if (!normalized) return null;
  for (const candidate of [...BUILT_IN_MEDIA_SITES, ...additions]) {
    if (normalized === candidate || normalized.endsWith(`.${candidate}`)) {
      return candidate;
    }
  }
  return null;
}

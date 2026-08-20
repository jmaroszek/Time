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

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Dotted-quad only, and no leading zeros, matching what Python's ip_address
// accepts — a self-hosted Jellyfin or Plex is reached by address as often as
// by name, and "localhost" below is the same case one hop closer.
const IPV4 = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/;

/** Normalize one typed or pasted site into the host shape sessions store.
 *
 *  Mirrors normalize_host in tracker/domains.py: a settings field is where
 *  people type "YouTube.com", "www.netflix.com/browse", or a whole copied URL,
 *  and an entry that does not survive that typing would match nothing. Returns
 *  "" for anything that is not host-shaped once the decoration is gone. */
export function normalizeMediaSite(raw: string): string {
  let candidate = raw.trim().toLowerCase();
  if (candidate.includes("://")) candidate = candidate.split("://")[1] ?? "";
  for (const separator of ["/", "?", "#"]) {
    candidate = candidate.split(separator)[0] ?? "";
  }
  // Userinfo before the port: "user:pass@host" holds a colon of its own.
  const at = candidate.lastIndexOf("@");
  if (at >= 0) candidate = candidate.slice(at + 1);
  candidate = candidate.split(":")[0] ?? "";
  candidate = candidate.replace(/\.+$/, "").replace(/^www\./, "");
  if (!candidate || candidate.length > 253) return "";
  if (IPV4.test(candidate)) {
    return candidate.split(".").every((octet) => Number(octet) <= 255)
      ? candidate
      : "";
  }
  if (candidate === "localhost") return candidate;
  const labels = candidate.split(".");
  if (labels.length < 2) return "";
  if (labels.every((label) => /^\d+$/.test(label))) return "";
  if (!labels.every((label) => HOST_LABEL.test(label))) return "";
  return candidate;
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

// A short list of common Windows applications, used to *offer* a category for
// an app the user has not classified yet.
//
// Nothing here classifies anything. A suggestion marks an entry in a menu and
// fills a review sheet; a rule exists only once the user says yes, and what
// they accept is an ordinary rule indistinguishable from one they typed. That
// is the boundary the Window-rule redesign settled and this feature keeps: Time
// does not silently infer categories.
//
// Every gate below fails toward *not* suggesting, for the same reason
// domainConsolidation.ts does: a missed suggestion costs nothing — the app sits
// in Unclassified, where it already was — while a wrong one teaches the reader
// to dismiss the next without reading it.
//
// Two things deliberately get no suggestion:
//
//   bimodal     Discord and OBS serve work and leisure for different people. A
//               single default merges two things a tracker exists to separate.
//   everything  An unlisted app is not a failure. Games in particular cannot be
//   unlisted    cataloged — they ship under names like r5apex_dx12.exe — which is
//               what NAME_SHAPES is for, and past that the queue is the answer.
//
// Browsers were a third until a VM test pass produced the counter-evidence.
// The argument for excluding them was that a browser's category "would cover
// every site visited inside it" and swallow website time. It does not: rules
// resolve domain before process, so an exported session for youtube.com lands in
// Entertainment while the same browser with no detected domain lands in
// Browsing. A browser rule is a *fallback* for the browser time nothing else
// explains, which is what a reader means by classifying it.
//
// What the old reasoning got right is that the state it creates is misleading on
// its own — a classified browser looks finished, so nothing suggests the sites
// inside could be separated. That is real, and it already has an owner:
// shouldShowWebsiteRuleHint in domainCoverage.ts exists for exactly this reader
// and fires once websites are being recorded and no domain rule exists. Suppress
// the suggestion and browsers are simply the one recognized app that offers a
// new user nothing on day one.
//
// This is not a source of display names. cleanProcessName in format.ts stays
// mechanical ("production code never guesses app identities"); the catalog only
// informs which category is offered.
//
// It does not explain itself either. Each role used to carry a sentence — "A
// developer tool" — shown beside the suggestion, and the surfaces that printed
// it are gone: the menu marks its entry with a word, and the review sheet lists
// a duration. RECOGNIZED_NOT_SUGGESTED lost its own prose the same way: the
// review sheet no longer lists what it declines to suggest, on the reasoning
// that "Time recognizes this but won't guess" is a fact about the backend, not
// something the reader can act on — they classify it by hand either way.

import type { ActivityEntityKind } from "./activity";
import { entityId } from "./entityIdentity";
import type { Category } from "./classify";

/** What an app is *for*. Never what it is worth — that judgment belongs to the
 *  category's productivity flags, which the user owns. Roles stay distinct even
 *  where several bind to one category today, so a user who later makes a
 *  "Design" category can be matched without re-cataloging every entry. */
export type StarterRole =
  | "system"
  | "plumbing"
  | "browsing"
  | "messaging"
  | "development"
  | "writing"
  | "creative"
  | "study"
  | "gaming"
  | "media";

/**
 * Starter category that satisfies each role.
 *
 * Resolved by current name rather than by ids captured at onboarding, which
 * keeps the seed a plain list and works for existing installs that never saw an
 * onboarding screen. Exact starter names are intentional: deleting or renaming
 * one is the reader declining that piece of Time's taxonomy, so suggestions
 * aimed at it must disappear rather than following the category under a name
 * Time happens to consider synonymous.
 *
 * A missing starter name resolves to nothing and that role simply makes no
 * suggestions. That is the right outcome, not a gap — the user's taxonomy wins.
 */
const ROLE_CATEGORY: Record<StarterRole, string> = {
  system: "system",
  plumbing: "ignored",
  browsing: "browsing",
  messaging: "communication",
  development: "work",
  writing: "work",
  creative: "work",
  study: "work",
  gaming: "entertainment",
  media: "entertainment",
};

/**
 * Process name -> role. Lowercase, `.exe`-suffixed, matching how sessions store
 * the Win32 image name and how App rules compare it.
 *
 * Exact matches only: classify.ts looks a process up in a Map, so there is no
 * wildcard to lean on and a version-bearing name like `gimp-2.10.exe` could
 * never be covered by one entry. Keep names that carry a version out.
 */
export const STARTER_APPS: Readonly<Record<string, StarterRole>> = {
  // Windows itself. explorer.exe is the one that accumulates real time.
  "explorer.exe": "system",
  "taskmgr.exe": "system",
  "systemsettings.exe": "system",
  "control.exe": "system",
  "searchhost.exe": "system",
  "searchapp.exe": "system",
  "mmc.exe": "system",
  "regedit.exe": "system",
  "cleanmgr.exe": "system",
  "msconfig.exe": "system",
  "snippingtool.exe": "system",
  "charmap.exe": "system",
  "calculatorapp.exe": "system",
  "osk.exe": "system",
  "magnify.exe": "system",
  "narrator.exe": "system",
  "resmon.exe": "system",
  "perfmon.exe": "system",
  "dxdiag.exe": "system",
  "msinfo32.exe": "system",
  "tabtip.exe": "system",
  "7zfm.exe": "system",
  "winrar.exe": "system",
  "winstore.app.exe": "system",
  // Shells ship as Windows utilities rather than developer tools. A developer
  // will reclassify them to Work in one step; suggesting Work to everyone else
  // asserts that opening a terminal was a job, which is the wrong way round for
  // the reader who has one open because something told them to run a command.
  "windowsterminal.exe": "system",
  "powershell.exe": "system",
  "pwsh.exe": "system",
  "cmd.exe": "system",
  // Browsers. The suggestion is a fallback for browser time no domain explains —
  // sites that were detected classify on their own, ahead of this. Listed here as
  // well as covered by the caller's live `browser_processes` set, so a reader who
  // prunes that set still gets the offer for a browser Time plainly recognizes.
  "chrome.exe": "browsing",
  "msedge.exe": "browsing",
  "firefox.exe": "browsing",
  "brave.exe": "browsing",
  "opera.exe": "browsing",
  "vivaldi.exe": "browsing",
  "arc.exe": "browsing",
  "chromium.exe": "browsing",
  // Sync clients and peripheral vendor apps: ordinary Windows time nobody wants
  // to think about, under stable and unambiguous names.
  "onedrive.exe": "system",
  "dropbox.exe": "system",
  "googledrivefs.exe": "system",
  "nvidia app.exe": "system",
  "nvidia share.exe": "system",
  "lghub.exe": "system",
  "razer synapse 3.exe": "system",
  "icue.exe": "system",
  // Plumbing. Never a thing a person "used", and worth hiding rather than
  // merely categorizing — hence Ignored. noise.ts folds most of these out of the
  // catalog view, but folded time still counts as unclassified in Insights.
  "dwm.exe": "plumbing",
  "pickerhost.exe": "plumbing",
  "credentialuibroker.exe": "plumbing",
  "lockapp.exe": "plumbing",
  "startmenuexperiencehost.exe": "plumbing",
  "openwith.exe": "plumbing",
  "shellexperiencehost.exe": "plumbing",
  "shellhost.exe": "plumbing",
  "applicationframehost.exe": "plumbing",
  "textinputhost.exe": "plumbing",
  "searchindexer.exe": "plumbing",
  "sihost.exe": "plumbing",
  "taskhostw.exe": "plumbing",
  "fontdrvhost.exe": "plumbing",
  "ctfmon.exe": "plumbing",
  "audiodg.exe": "plumbing",
  "logonui.exe": "plumbing",
  "consent.exe": "plumbing",
  "smartscreen.exe": "plumbing",
  "werfault.exe": "plumbing",
  "systemsettingsbroker.exe": "plumbing",
  // Messaging. Communication ships neutral, so "this is a messaging app" is a
  // claim about the app and not about whether talking to people was worthwhile.
  "slack.exe": "messaging",
  "teams.exe": "messaging",
  "ms-teams.exe": "messaging",
  "outlook.exe": "messaging",
  "olk.exe": "messaging",
  "thunderbird.exe": "messaging",
  "zoom.exe": "messaging",
  "skype.exe": "messaging",
  "webex.exe": "messaging",
  "telegram.exe": "messaging",
  "whatsapp.exe": "messaging",
  "signal.exe": "messaging",
  // Development.
  "code.exe": "development",
  "devenv.exe": "development",
  "sublime_text.exe": "development",
  "notepad++.exe": "development",
  "idea64.exe": "development",
  "pycharm64.exe": "development",
  "webstorm64.exe": "development",
  "clion64.exe": "development",
  "rider64.exe": "development",
  "goland64.exe": "development",
  "phpstorm64.exe": "development",
  "rubymine64.exe": "development",
  "datagrip64.exe": "development",
  "studio64.exe": "development",
  "githubdesktop.exe": "development",
  "sourcetree.exe": "development",
  "fork.exe": "development",
  "postman.exe": "development",
  "insomnia.exe": "development",
  "dbeaver.exe": "development",
  "ssms.exe": "development",
  "db browser for sqlite.exe": "development",
  "docker desktop.exe": "development",
  "putty.exe": "development",
  "winscp.exe": "development",
  "filezilla.exe": "development",
  "mobaxterm.exe": "development",
  "unity.exe": "development",
  "unrealeditor.exe": "development",
  "godot.exe": "development",
  "cursor.exe": "development",
  // Documents and notes.
  "winword.exe": "writing",
  "excel.exe": "writing",
  "powerpnt.exe": "writing",
  "onenote.exe": "writing",
  "msaccess.exe": "writing",
  "obsidian.exe": "writing",
  "notion.exe": "writing",
  "evernote.exe": "writing",
  "typora.exe": "writing",
  "scrivener.exe": "writing",
  "notepad.exe": "writing",
  "sumatrapdf.exe": "writing",
  "acrord32.exe": "writing",
  "acrobat.exe": "writing",
  "soffice.exe": "writing",
  "swriter.exe": "writing",
  "scalc.exe": "writing",
  // Creative.
  "photoshop.exe": "creative",
  "illustrator.exe": "creative",
  "indesign.exe": "creative",
  "mspaint.exe": "creative",
  "afterfx.exe": "creative",
  "lightroom.exe": "creative",
  "adobe premiere pro.exe": "creative",
  "davinciresolve.exe": "creative",
  "clipchamp.exe": "creative",
  "figma.exe": "creative",
  "blender.exe": "creative",
  "inkscape.exe": "creative",
  "krita.exe": "creative",
  "audacity.exe": "creative",
  // Study and reference.
  "anki.exe": "study",
  "zotero.exe": "study",
  "calibre.exe": "study",
  // Games and their launchers. Individual titles are hopeless — see NAME_SHAPES.
  "steam.exe": "gaming",
  "steamwebhelper.exe": "gaming",
  "epicgameslauncher.exe": "gaming",
  "battle.net.exe": "gaming",
  "galaxyclient.exe": "gaming",
  "eadesktop.exe": "gaming",
  "ubisoftconnect.exe": "gaming",
  "riotclientux.exe": "gaming",
  "robloxplayerbeta.exe": "gaming",
  // Media.
  "spotify.exe": "media",
  "applemusic.exe": "media",
  "itunes.exe": "media",
  "netflix.exe": "media",
  "vlc.exe": "media",
  "wmplayer.exe": "media",
  "mpc-hc64.exe": "media",
  "tidal.exe": "media",
  "plex.exe": "media",
};

/**
 * Apps Time can name but will not place.
 *
 * These are genuinely bimodal: the same app is work for one person and leisure
 * for the next, and a default would merge exactly the two things worth telling
 * apart. This list also exists so the next contributor does not helpfully add
 * discord.exe to the catalog above.
 *
 * Browsers used to be here. They are in the catalog now, under the `browsing`
 * role — see the header for why the "a browser rule swallows website time"
 * argument does not survive contact with how rules actually resolve.
 */
export const RECOGNIZED_NOT_SUGGESTED: ReadonlySet<string> = new Set([
  "discord.exe",
  "obs64.exe",
  "obs32.exe",
]);

/**
 * Naming conventions that identify a family no catalog could enumerate.
 *
 * `-Win64-Shipping.exe` is how Unreal Engine packages a shipping build, so it
 * covers titles nobody has heard of yet; the anti-cheat launchers are the same
 * game wearing a second executable name. Measured against a real history these
 * two patterns reached more time than every system-utility entry above combined.
 *
 * Installer and driver shapes are deliberately absent: noise.ts already folds
 * those out of the catalog, and they were worth a rounding error.
 */
const NAME_SHAPES: readonly { pattern: RegExp; role: StarterRole }[] = [
  // How Unreal Engine names a shipping build.
  { pattern: /-win(?:32|64)-shipping\.exe$/, role: "gaming" },
  // A game's anti-cheat launcher, wearing a second executable name.
  { pattern: /(?:_eac|_be)\.exe$|^start_protected_game\.exe$/, role: "gaming" },
];

/** The fields a suggestion needs. Structural so a triage row and a test fixture
 *  both satisfy it without either being converted to the other. */
export interface SuggestibleEntity {
  kind: ActivityEntityKind;
  key: string;
}

export interface StarterSuggestion<T extends SuggestibleEntity> {
  entity: T;
  categoryId: number;
}

export function suggestionKey(entity: SuggestibleEntity): string {
  return entityId(entity.kind, entity.key);
}

/**
 * Which category each role points at, or nothing when the user has no category
 * that plainly holds that kind of app.
 *
 * Aliases are tried in order so an explicit name wins over a fallback. Only the
 * plumbing role may land on an ignored category: hiding time is a stronger act
 * than filing it, and a user whose "Work" category happens to be ignored should
 * not have Time quietly suggest that their work disappear.
 */
export function resolveRoleCategories(
  categories: readonly Category[],
): Map<StarterRole, number> {
  const resolved = new Map<StarterRole, number>();
  for (const [role, name] of Object.entries(ROLE_CATEGORY) as [StarterRole, string][]) {
    const match = categories.find(
      (category) =>
        category.name.trim().toLowerCase() === name
        && (role === "plumbing" ? category.isIgnored : !category.isIgnored),
    );
    if (match) {
      resolved.set(role, match.id);
    }
  }
  return resolved;
}

/** The role Time would file this process under, or null. Exported for tests and
 *  for the review sheet's grouping. */
export function roleForProcess(process: string): StarterRole | null {
  const name = process.trim().toLowerCase();
  if (!name) return null;
  const listed = STARTER_APPS[name];
  if (listed) return listed;
  for (const shape of NAME_SHAPES) if (shape.pattern.test(name)) return shape.role;
  return null;
}

/**
 * Suggestions for a set of unclassified entities.
 *
 * Websites are out of scope: a domain says far more about intent than an
 * executable does, and the list that would serve them is a different list.
 */
export function suggestForTriage<T extends SuggestibleEntity>(
  entities: readonly T[],
  categories: readonly Category[],
  dismissed: ReadonlySet<string>,
  browserProcesses: ReadonlySet<string>,
): StarterSuggestion<T>[] {
  const roleCategories = resolveRoleCategories(categories);
  const suggestions: StarterSuggestion<T>[] = [];
  for (const entity of entities) {
    if (entity.kind !== "app") continue;
    const name = entity.key.trim().toLowerCase();
    if (RECOGNIZED_NOT_SUGGESTED.has(name)) continue;
    if (dismissed.has(suggestionKey(entity))) continue;
    // The configured set outranks the catalog: a browser this user added by hand
    // is a browser on their say-so, which is better evidence than any list
    // shipped here — including for a name the catalog happens to know as
    // something else.
    const role = browserProcesses.has(name) ? "browsing" : roleForProcess(name);
    if (!role) continue;
    const categoryId = roleCategories.get(role);
    if (categoryId === undefined) continue;
    suggestions.push({ entity, categoryId });
  }
  return suggestions;
}

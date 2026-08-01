// A short list of common Windows applications, used to *offer* a category for
// an app the user has not classified yet.
//
// Nothing here classifies anything. A suggestion pre-fills a control and fills a
// review sheet; a rule exists only once the user says yes, and what they accept
// is an ordinary rule indistinguishable from one they typed. That is the
// boundary the Window-rule redesign settled and this feature keeps: Time does
// not silently infer categories.
//
// Every gate below fails toward *not* suggesting, for the same reason
// domainConsolidation.ts does: a missed suggestion costs nothing — the app sits
// in Unclassified, where it already was — while a wrong one teaches the reader
// to dismiss the next without reading it.
//
// Three things deliberately get no suggestion:
//
//   browsers    A browser's category would cover every site visited inside it.
//               Domains are only visible when Time Website Integration (or a
//               compatible legacy extension) is installed, so most browser time
//               carries none, and a browser rule would swallow it *and* take the
//               browser out of the queue that would have prompted a fix.
//               RECOGNIZED_NOT_SUGGESTED lists them, and the caller's live
//               `browser_processes` set is checked too.
//   bimodal     Discord and OBS serve work and leisure for different people. A
//               single default merges two things a tracker exists to separate.
//   everything  An unlisted app is not a failure. Games in particular cannot be
//   unlisted    cataloged — they ship under names like r5apex_dx12.exe — which is
//               what NAME_SHAPES is for, and past that the queue is the answer.
//
// This is not a source of display names. cleanProcessName in format.ts stays
// mechanical ("production code never guesses app identities"); the catalog only
// informs a suggestion and the sentence explaining it.

import type { ActivityEntityKind } from "./activity";
import type { Category } from "./classify";

/** What an app is *for*. Never what it is worth — that judgment belongs to the
 *  category's productivity flags, which the user owns. Roles stay distinct even
 *  where several bind to one category today, so a user who later makes a
 *  "Design" category can be matched without re-cataloging every entry. */
export type StarterRole =
  | "system"
  | "plumbing"
  | "messaging"
  | "development"
  | "writing"
  | "creative"
  | "study"
  | "gaming"
  | "media";

/**
 * Category names that satisfy each role, best first.
 *
 * Resolved by name rather than by ids captured at onboarding, which keeps the
 * seed a plain list and makes the feature work three ways at once: for the
 * starter taxonomy, for a user who renamed a category to something equivalent,
 * and for an existing install that never saw an onboarding screen.
 *
 * A name outside these lists resolves to nothing and that role simply makes no
 * suggestions. That is the right outcome, not a gap — a category named something
 * the catalog does not recognize is one the user has made their own.
 */
const ROLE_ALIASES: Record<StarterRole, readonly string[]> = {
  system: ["system", "utilities", "utility"],
  plumbing: ["ignored"],
  messaging: ["communication", "comms", "messaging", "chat", "email", "mail"],
  development: ["work", "development", "dev", "coding", "focus", "projects", "deep work"],
  writing: ["work", "notes", "writing", "documents", "focus", "projects", "deep work"],
  creative: ["work", "creative", "design", "focus", "projects", "deep work"],
  study: ["work", "learning", "study", "research", "focus", "projects", "deep work"],
  gaming: ["entertainment", "gaming", "games"],
  media: ["entertainment", "media", "music", "video"],
};

/** One sentence per role rather than per app. A hundred hand-written rationales
 *  would rot; the role is the actual reason in every case. */
const ROLE_REASON: Record<StarterRole, string> = {
  system: "A Windows system tool",
  plumbing: "Windows background plumbing, not something you use",
  messaging: "A messaging or email app",
  development: "A developer tool",
  writing: "A documents or notes app",
  creative: "A design or media-editing app",
  study: "A study or reference app",
  gaming: "A game or game launcher",
  media: "A music or video app",
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
  "mspaint.exe": "system",
  "7zfm.exe": "system",
  "winrar.exe": "system",
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
  "shellexperiencehost.exe": "plumbing",
  "shellhost.exe": "plumbing",
  "applicationframehost.exe": "plumbing",
  "textinputhost.exe": "plumbing",
  "searchindexer.exe": "plumbing",
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
  "windowsterminal.exe": "development",
  "powershell.exe": "development",
  "pwsh.exe": "development",
  "cmd.exe": "development",
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
  "afterfx.exe": "creative",
  "lightroom.exe": "creative",
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
};

/**
 * Apps Time can name but will not place, and why — shown so the silence reads as
 * a decision rather than a gap.
 *
 * The browsers are here because a category on the container would cover every
 * site inside it. The rest are genuinely bimodal: the same app is work for one
 * person and leisure for the next, and a default would merge exactly the two
 * things worth telling apart. This list also exists so the next contributor does
 * not helpfully add discord.exe to the catalog above.
 */
export const RECOGNIZED_NOT_SUGGESTED: Readonly<Record<string, string>> = {
  "chrome.exe": "Time can't tell which sites without Time Website Integration",
  "msedge.exe": "Time can't tell which sites without Time Website Integration",
  "firefox.exe": "Time can't tell which sites without Time Website Integration",
  "brave.exe": "Time can't tell which sites without Time Website Integration",
  "opera.exe": "Time can't tell which sites without Time Website Integration",
  "vivaldi.exe": "Time can't tell which sites without Time Website Integration",
  "arc.exe": "Time can't tell which sites without Time Website Integration",
  "chromium.exe": "Time can't tell which sites without Time Website Integration",
  "discord.exe": "Work chat for some people, leisure for others",
  "obs64.exe": "Screen recording is work for some people, streaming is not for others",
  "obs32.exe": "Screen recording is work for some people, streaming is not for others",
};

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
const NAME_SHAPES: readonly { pattern: RegExp; role: StarterRole; reason: string }[] = [
  {
    pattern: /-win(?:32|64)-shipping\.exe$/,
    role: "gaming",
    reason: "Named the way Unreal Engine packages a game",
  },
  {
    pattern: /(?:_eac|_be)\.exe$|^start_protected_game\.exe$/,
    role: "gaming",
    reason: "Named like a game's anti-cheat launcher",
  },
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
  /** One line, shown beside the suggestion. Never a claim about the person. */
  reason: string;
}

export interface RecognizedEntity<T extends SuggestibleEntity> {
  entity: T;
  reason: string;
}

/** Stable identity for a dismissal. Matches the entity id activity.ts builds, so
 *  an app and a website of the same name cannot dismiss each other. */
export function suggestionKey(entity: SuggestibleEntity): string {
  return `${entity.kind}:${entity.key.toLowerCase()}`;
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
  for (const [role, aliases] of Object.entries(ROLE_ALIASES) as [StarterRole, readonly string[]][]) {
    for (const alias of aliases) {
      const match = categories.find(
        (category) =>
          category.name.trim().toLowerCase() === alias
          && (role === "plumbing" ? category.isIgnored : !category.isIgnored),
      );
      if (match) {
        resolved.set(role, match.id);
        break;
      }
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

function reasonForProcess(process: string, role: StarterRole): string {
  const name = process.trim().toLowerCase();
  if (STARTER_APPS[name]) return ROLE_REASON[role];
  const shape = NAME_SHAPES.find((candidate) => candidate.pattern.test(name));
  return shape ? shape.reason : ROLE_REASON[role];
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
    // The configured set, not just the names above: a browser this user added by
    // hand must be as untouchable as one that shipped in the defaults.
    if (browserProcesses.has(name)) continue;
    if (name in RECOGNIZED_NOT_SUGGESTED) continue;
    if (dismissed.has(suggestionKey(entity))) continue;
    const role = roleForProcess(name);
    if (!role) continue;
    const categoryId = roleCategories.get(role);
    if (categoryId === undefined) continue;
    suggestions.push({ entity, categoryId, reason: reasonForProcess(name, role) });
  }
  return suggestions;
}

/** Entities Time recognizes and is declining to place, with the reason. Shown
 *  below the suggestions so the reader learns where the line is. */
export function recognizedWithoutSuggestion<T extends SuggestibleEntity>(
  entities: readonly T[],
  browserProcesses: ReadonlySet<string>,
): RecognizedEntity<T>[] {
  const recognized: RecognizedEntity<T>[] = [];
  for (const entity of entities) {
    if (entity.kind !== "app") continue;
    const name = entity.key.trim().toLowerCase();
    const reason = RECOGNIZED_NOT_SUGGESTED[name]
      ?? (browserProcesses.has(name)
        ? "Time can't tell which sites without Time Website Integration"
        : null);
    if (reason) recognized.push({ entity, reason });
  }
  return recognized;
}

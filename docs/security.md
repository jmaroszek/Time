# Security and privacy

Time is a local-first Windows application. It has no account system, remote
service, analytics, telemetry, advertising SDK, or application network client.
Its normal runtime data flow is:

`Win32 foreground/idle APIs → local tracker → per-user SQLite database → local dashboard`

## Privacy defaults

- Tracking is disabled until the user makes an explicit first-run choice.
- Window titles are a separate opt-in and are disabled by default.
- Browser URLs found in titles are processed in memory. Only the normalized
  domain may be retained; paths, queries, fragments, ports, and credentials are
  removed before storage.
- Fresh installations include no personal categories, aliases, preferences, or
  classification rules.
- Startup registration is per-user and created only after consent.
- Users can pause recording, delete selected history, erase all sessions, and
  make consistent local backups from the dashboard.

## Local storage and threat model

The live database and user-created backups are ordinary SQLite files under
`%LOCALAPPDATA%\Time`. Windows user-profile permissions protect them from other
standard user accounts. They are not encrypted by Time. Malware running as the
same user, an administrator, someone with the unlocked Windows session, or a
party with offline access to an unencrypted disk may read them. Use Windows
device encryption or BitLocker when protection at rest matters.

Window titles can contain document names, message subjects, or other sensitive
text. Leave title storage off unless that detail is worth the privacy cost.
Third-party browser extensions used for optional site splitting have their own
permissions and trust model; Time does not install or control them.

SQLite `secure_delete` is enabled. History deletion checkpoints the WAL and
compacts the database, but separate backup files are intentionally retained and
must be managed by the user.

## Application hardening

- The Tauri webview has a restrictive content-security policy and loads no
  remote application content.
- The webview receives no filesystem or shell capability and cannot choose a
  database path in release builds.
- Database mutations are limited in Rust to the expected tables and SQL shapes;
  schema operations, pragmas, attached databases, extensions, comments, and
  multi-statement queries are rejected.
- Schema versions are checked before writes. A newer database is opened
  read-only by older application code.
- The tracker, dashboard, and public installer must all be Authenticode-signed
  and timestamped. The repository release verifier rejects unsigned artifacts;
  provider setup is documented in [signing.md](signing.md).

## Reporting a vulnerability

Please do not publish exploitable details in a normal issue. Use the repository's
[private vulnerability reporting form](https://github.com/jmaroszek/Time/security/advisories/new)
with reproduction steps, affected versions, and impact. Reports about local
data exposure should state which Windows account/privilege boundary was crossed.

## Supported versions

Security fixes are provided for the latest published release. Development and
locally built artifacts are unsupported and may be unsigned.

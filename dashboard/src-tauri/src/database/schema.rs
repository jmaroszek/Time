//! The schema a fresh database gets, and how an older or newer one is recognized.

pub(crate) const SCHEMA_VERSION: i64 = 6;

/// Marks the one open failure a launch can repair by itself, so the caller can
/// recognize it without matching a formatted sentence.  Mirrors the
/// `DatabaseSchemaTooNew:` prefix the renderer uses for the opposite direction
/// in `dashboard/src/lib/schema.ts`; this one never reaches the renderer,
/// because a database this release is too new for is migrated before the
/// window exists.
pub(super) const OLDER_SCHEMA_PREFIX: &str = "DatabaseSchemaTooOld:";

/// Whether an `open` error means the database predates this release and the
/// tracker has not migrated it yet.
pub(crate) fn is_older_schema_error(error: &str) -> bool {
    error.starts_with(OLDER_SCHEMA_PREFIX)
}

/// Duplicated as `_SCHEMA` in tracker/db.py, because either runtime may create
/// the database first. Both suites compare a fresh database with
/// contracts/schema.json; change all three together.
pub(super) const BOOTSTRAP_SQL: &str = r#"
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL CHECK(end_ts >= start_ts),
    process TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    domain TEXT,
    is_afk INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(end_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_proc ON sessions(process);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL,
    is_productive INTEGER NOT NULL DEFAULT 0,
    is_neutral INTEGER NOT NULL DEFAULT 0,
    is_ignored INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER,
    weekly_goal_hours REAL NOT NULL DEFAULT 0
        CHECK(weekly_goal_hours BETWEEN 0 AND 100),
    goal_kind TEXT NOT NULL DEFAULT 'at_least'
        CHECK(goal_kind IN ('at_least','at_most'))
);
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    match_type TEXT NOT NULL CHECK(match_type IN ('process','domain','title')),
    pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    priority INTEGER NOT NULL DEFAULT 0,
    -- Window-only matching and scope fields. Empty strings on App/Website
    -- rules keep the contract explicit and make the composite UNIQUE stable.
    scope_kind TEXT NOT NULL DEFAULT ''
        CHECK(scope_kind IN ('','any','browsers','process','domain')),
    scope_value TEXT NOT NULL DEFAULT '',
    title_match_mode TEXT NOT NULL DEFAULT ''
        CHECK(title_match_mode IN ('','segment','phrase','contains')),
    title_anchor TEXT NOT NULL DEFAULT ''
        CHECK(title_anchor IN ('','any','first','interior','last')),
    CHECK (
        (
            match_type = 'title'
            AND scope_kind IN ('any','browsers','process','domain')
            AND title_match_mode IN ('segment','phrase','contains')
            AND title_anchor IN ('any','first','interior','last')
            AND (title_match_mode = 'segment' OR title_anchor = 'any')
            AND (
                (scope_kind IN ('any','browsers') AND scope_value = '')
                OR (scope_kind IN ('process','domain') AND length(scope_value) > 0)
            )
        )
        OR
        (
            match_type <> 'title'
            AND scope_kind = ''
            AND scope_value = ''
            AND title_match_mode = ''
            AND title_anchor = ''
        )
    ),
    UNIQUE(
        match_type, pattern, scope_kind, scope_value,
        title_match_mode, title_anchor
    )
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TRIGGER IF NOT EXISTS delete_category_rules
BEFORE DELETE ON categories FOR EACH ROW BEGIN
    DELETE FROM rules WHERE category_id = OLD.id;
END;
CREATE TABLE IF NOT EXISTS tracking_exclusions (
    kind TEXT NOT NULL CHECK(kind IN ('app','website')),
    pattern TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    PRIMARY KEY(kind, pattern)
);
CREATE TABLE IF NOT EXISTS session_corrections (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    corrected_start_ts INTEGER,
    corrected_end_ts INTEGER,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    updated_ts INTEGER NOT NULL,
    CHECK (
        (corrected_start_ts IS NULL AND corrected_end_ts IS NULL)
        OR
        (corrected_start_ts IS NOT NULL AND corrected_end_ts IS NOT NULL
         AND corrected_end_ts > corrected_start_ts)
    )
);
CREATE INDEX IF NOT EXISTS idx_session_corrections_category
    ON session_corrections(category_id);
CREATE TRIGGER IF NOT EXISTS cleanup_empty_session_corrections
AFTER DELETE ON categories FOR EACH ROW BEGIN
    DELETE FROM session_corrections
    WHERE corrected_start_ts IS NULL AND corrected_end_ts IS NULL AND category_id IS NULL;
END;
INSERT OR IGNORE INTO settings (key,value)
    SELECT 'starter_categories_pending','1'
    WHERE NOT EXISTS (SELECT 1 FROM categories);
WITH starter(name, color, is_productive, is_neutral, is_ignored, sort_order) AS (
    VALUES
        -- Mirrors _SEED_CATEGORIES in tracker/db.py, which explains why these
        -- names describe kinds of application rather than kinds of intent.
        -- Either half may create the database, so the two lists must agree.
        ('Work', '#2f6fc0', 1, 0, 0, 1),
        ('Communication', '#56c8d8', 0, 1, 0, 2),
        ('Browsing', '#e0a53a', 0, 1, 0, 3),
        ('Entertainment', '#e75fa0', 0, 0, 0, 4),
        ('System', '#828994', 0, 1, 0, 5),
        ('Ignored', '#44474e', 0, 0, 1, 99)
)
INSERT OR IGNORE INTO categories
    (name, color, is_productive, is_neutral, is_ignored, sort_order)
    SELECT * FROM starter
    WHERE (SELECT COUNT(*) FROM categories) = 0;
INSERT OR IGNORE INTO settings (key,value) VALUES
    -- Must track SCHEMA_VERSION above: this is what a database created by the
    -- dashboard rather than the tracker is stamped with, and open() refuses
    -- anything older than the constant.
    ('schema_version','6'),
    ('rule_priority_scheme','low-wins-v1'),
    ('weekly_goal_hours','0'),
    ('idle_threshold_seconds','300'),
    ('heartbeat_seconds','15'),
    ('week_start','auto'),
    ('browser_processes','chrome.exe,msedge.exe,firefox.exe,opera.exe,brave.exe,vivaldi.exe,chromium.exe,thorium.exe,floorp.exe,librewolf.exe,waterfox.exe,zen.exe'),
    ('min_app_seconds_per_day','0'),
    -- Extra media sites, on top of the built-in list in
    -- tracker/media_playback.py. Empty on a fresh install by design.
    ('media_domains',''),
    -- off | one_off | utilities_only | utilities, where 'utilities' is the
    -- historical value meaning *both* filters and 'utilities_only' is the
    -- narrower one. Ships as utilities_only; see the mode constants in
    -- dashboard/src/lib/noise.ts.
    ('activity_noise_filter','utilities_only'),
    ('activity_noise_max_seconds','120'),
    ('activity_noise_max_sessions','1'),
    ('color_palette','slate'),
    ('productivity_style','vivid'),
    ('theme','system'),
    ('focus_chain_max_gap_seconds','300'),
    ('break_reminder_enabled','0'),
    ('break_reminder_seconds','3600'),
    ('day_start_hour','0'),
    ('day_end_hour','24'),
    ('tracking_paused','0'),
    ('tracking_paused_until','0'),
    ('tracking_schedule_enabled','0'),
    ('tracking_schedule_days','0,1,2,3,4'),
    ('tracking_schedule_start_minute','540'),
    ('tracking_schedule_end_minute','1020'),
    ('recording_consent','0'),
    ('record_window_titles','0'),
    ('record_browser_domains','1'),
    ('privacy_onboarding_complete','0'),
    ('launch_at_login','0'),
    ('show_tray_icon','1'),
    ('check_updates_automatically','1'),
    ('feedback_prompts_enabled','1');
COMMIT;
"#;

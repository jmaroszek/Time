use super::exclusions::normalize_website_host;
use super::settings::schedule_allows_local;
use super::{
    is_older_schema_error, ActivityDeleteRequest, SessionClassificationRequest,
    SessionCorrectionRequest, SettingUpdate, TimeDatabase, BOOTSTRAP_SQL, SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn entity_assignment(pattern: &str, category_id: i64) -> super::EntityRuleAssignment {
    super::EntityRuleAssignment {
        match_type: "process".into(),
        pattern: pattern.into(),
        category_id,
        priority: 3,
    }
}

#[test]
fn entity_batch_failure_and_stale_undo_never_partially_change_rules() {
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(scratch_root("entity-batch").join("database.db"))
            .await
            .unwrap();
        database
            .assign_entity_rule("process", "editor.exe", 1, 3)
            .await
            .unwrap();
        assert!(database
            .assign_entity_rules(vec![
                entity_assignment("editor.exe", 2),
                entity_assignment("notes.exe", 999_999)
            ])
            .await
            .is_err());
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT pattern,category_id FROM rules ORDER BY pattern")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(rows, [("editor.exe".into(), 1)]);
        let changes = database
            .assign_entity_rules(vec![
                entity_assignment("editor.exe", 2),
                entity_assignment("notes.exe", 3),
            ])
            .await
            .unwrap();
        // Change the last item so an implementation undoing one row at a
        // time would already have destroyed the first change when it fails.
        database
            .assign_entity_rule("process", "notes.exe", 4, 3)
            .await
            .unwrap();
        assert!(database
            .undo_entity_rules(changes)
            .await
            .unwrap_err()
            .contains("changed after"));
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT pattern,category_id FROM rules ORDER BY pattern")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(rows, [("editor.exe".into(), 2), ("notes.exe".into(), 4)]);
        database.close().await;
    });
}

#[test]
fn entity_undo_restores_previous_meaning_and_is_not_replayable() {
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(scratch_root("entity-undo").join("database.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO rules(match_type,pattern,category_id,priority) VALUES('process','EDITOR.EXE',1,7)")
                .execute(&database.pool).await.unwrap();
        let changes = database
            .assign_entity_rules(vec![
                entity_assignment("editor.exe", 2),
                entity_assignment("notes.exe", 3),
            ])
            .await
            .unwrap();
        database.undo_entity_rules(changes.clone()).await.unwrap();
        let rows: Vec<(String, i64, i64)> =
            sqlx::query_as("SELECT pattern,category_id,priority FROM rules ORDER BY pattern")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(rows, [("EDITOR.EXE".into(), 1, 7)]);
        assert!(database.undo_entity_rules(changes).await.is_err());
        database.close().await;
    });
}

struct RecorderProcess {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}

impl RecorderProcess {
    fn start(path: &Path) -> Self {
        use std::io::BufRead;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let local = root.join("data/tracker-build-env/Scripts/python.exe");
        let python = std::env::var_os("TIME_TEST_PYTHON").unwrap_or_else(|| {
            if local.is_file() {
                local.into_os_string()
            } else {
                "python".into()
            }
        });
        let mut child = std::process::Command::new(python)
            .arg(root.join("tracker/tests/interop_worker.py"))
            .arg(path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("Python is required for the native/tracker contract tests");
        let input = child.stdin.take().unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert!(
            ready.contains("ready"),
            "recorder did not initialize: {ready}"
        );
        Self {
            child,
            input,
            output,
        }
    }

    fn step(&mut self, command: serde_json::Value) -> serde_json::Value {
        use std::io::{BufRead, Write};
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        let mut response = String::new();
        self.output.read_line(&mut response).unwrap();
        serde_json::from_str(&response).expect("recorder response")
    }
}

impl Drop for RecorderProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn native_exclusion_cannot_be_reintroduced_by_a_stale_recorder_afk_transition() {
    use serde_json::json;
    tauri::async_runtime::block_on(async {
        let path = scratch_database("recorder-exclusion-interleaving");
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        database
            .update_lifecycle_settings(&[("recording_consent", "1")])
            .await
            .unwrap();
        let now = super::unix_now().unwrap();
        let mut recorder = RecorderProcess::start(&path);
        recorder.step(json!({"now": now - 400}));
        recorder.step(json!({"now": now - 20, "idle": 280}));
        database
            .add_tracking_exclusion("app", "editor.exe", true)
            .await
            .unwrap();
        let stale = recorder.step(json!({"now": now, "idle": 300, "refresh": false}));
        assert!(
            stale
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["process"] != "editor.exe"),
            "the exclusion must apply even before the next settings refresh: {stale}"
        );
        let refreshed = recorder.step(json!({"now": now + 1, "idle": 301}));
        assert!(refreshed
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["process"] == "afk"));
        recorder.step(json!({"now": now + 2, "shutdown": true}));
        drop(recorder);
        database.close().await;
    });
}

#[test]
fn native_edits_and_deletion_respect_a_running_recorder_and_pause_boundary() {
    use serde_json::json;
    tauri::async_runtime::block_on(async {
        let path = scratch_database("recorder-native-boundaries");
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        database
            .update_lifecycle_settings(&[("recording_consent", "1")])
            .await
            .unwrap();
        let now = super::unix_now().unwrap();
        let mut recorder = RecorderProcess::start(&path);
        recorder.step(json!({"now": now - 40}));
        recorder.step(json!({"now": now - 20}));
        let correction = SessionCorrectionRequest {
            session_id: 1,
            start_sec: (now - 40) as f64,
            end_sec: (now - 30) as f64,
            category_id: None,
        };
        assert!(database.correct_session(&correction).await.is_err());
        let mut request = ActivityDeleteRequest {
            mode: "sessions".into(),
            session_ids: vec![1],
            entity_kind: None,
            entity_key: None,
            start_sec: None,
            end_sec: None,
            browser_processes: vec![],
            snapshot_max_id: None,
            preview_protected_session_id: None,
        };
        let preview = database.preview_activity_delete(&request).await.unwrap();
        assert_eq!(preview.protected_count, 1);
        database
            .update_lifecycle_settings(&[("tracking_paused", "1")])
            .await
            .unwrap();
        recorder.step(json!({"now": now - 10}));
        let corrected = database.correct_session(&correction).await.unwrap();
        assert_eq!(corrected.original_end, now - 10);
        assert_eq!(corrected.end, now - 30);
        let preview = database.preview_activity_delete(&request).await.unwrap();
        request.snapshot_max_id = Some(preview.snapshot_max_id);
        assert_eq!(
            database
                .delete_activity(&request)
                .await
                .unwrap()
                .deleted_count,
            1
        );
        database
            .update_lifecycle_settings(&[("tracking_paused", "0")])
            .await
            .unwrap();
        let resumed = recorder.step(json!({"now": now, "idle": 600}));
        assert_eq!(resumed.as_array().unwrap().len(), 1);
        assert_eq!(resumed[0]["start_ts"], now);
        recorder.step(json!({"now": now + 1, "shutdown": true}));
        drop(recorder);
        database.close().await;
    });
}

/// A directory no previous run has touched.
///
/// Sharing one path means deleting the last run's files first, and on
/// Windows a handle that has not finished closing turns that into a sharing
/// violation — or leaves the directory in a delete-pending state where a
/// file written afterwards silently disappears. Both were live flakes here.
///
/// Nothing deletes these during the run that made them, for the same
/// reason: a run that tidied up would be racing the handles it just closed.
/// They therefore accumulate, one per filesystem-touching test per
/// invocation, and collecting them under a single parent is what keeps
/// `target/` navigable — 11k loose directories once buried the release
/// bundle. `sweep_old_scratch` bounds the pile at a day's worth.
fn scratch_root(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static SWEPT: Once = Once::new();
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let parent = std::env::current_dir()
        .unwrap()
        .join("target")
        .join("test-scratch");
    // Once per test process: the sweep reads one directory, and doing it
    // per scratch-using test would read it sixteen times for one result.
    SWEPT.call_once(|| sweep_old_scratch(&parent));
    let root = parent.join(format!("{name}-{stamp}-{unique}"));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// Delete scratch directories left by earlier runs.
///
/// Age is the discriminator rather than ownership, which is what makes this
/// safe to do at startup: a directory another run is still using is minutes
/// old at most, so a day-old one cannot belong to a run still in progress.
/// That keeps the guarantee `scratch_root` depends on — no run ever touches
/// a path a live handle might still own — while bounding a pile that
/// otherwise grows by every scratch-using test, forever.
///
/// Every failure is ignored. A directory that will not delete is one
/// something else is holding, which is precisely the case to leave alone;
/// the next run finds it a day older and no more troublesome.
fn sweep_old_scratch(parent: &Path) {
    const KEEP: Duration = Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata.is_dir()
            && metadata
                .modified()
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > KEEP);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn scratch_database(name: &str) -> PathBuf {
    scratch_root(name).join("database.db")
}

#[test]
fn rejects_dangerous_or_multi_statement_sql() {
    for query in [
        "DROP TABLE sessions",
        "SELECT * FROM sessions; DELETE FROM sessions",
        "SELECT * FROM pragma_table_info('sessions')",
        "SELECT 1 -- comment",
    ] {
        assert!(TimeDatabase::validate_sql(query, &["SELECT"]).is_err());
    }
}

#[test]
fn restricts_webview_mutation_targets() {
    assert!(TimeDatabase::validate_mutation_target(
        "INSERT INTO settings (key,value) VALUES ($1,$2)"
    )
    .is_err());
    assert!(TimeDatabase::validate_mutation_target("DELETE FROM sessions WHERE id=$1").is_err());
    assert!(
        TimeDatabase::validate_mutation_target("UPDATE rules SET pattern=$1 WHERE id=$2").is_ok()
    );
    // Category goals are written by the renderer, like a category's name.
    assert!(TimeDatabase::validate_mutation_target(
        "UPDATE categories SET weekly_goal_hours = $1, goal_kind = $2 WHERE id = $3"
    )
    .is_ok());
    assert!(TimeDatabase::validate_mutation_target("UPDATE settings SET value='1'").is_err());
    assert!(TimeDatabase::validate_mutation_target("DELETE FROM settings").is_err());
}

/// The launch path repairs exactly one open failure by handing the database
/// to the tracker, so it has to be able to recognize that one and no other.
/// A schema older than this release is the only self-repairable case; every
/// other failure ends the launch, and mistaking one for this would spawn a
/// tracker at a database it cannot help with.
#[test]
fn an_older_database_reports_a_recognizable_migration_error() {
    tauri::async_runtime::block_on(async {
        let path = scratch_database("older-schema");
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        database
            .update_lifecycle_settings(&[("schema_version", "5")])
            .await
            .unwrap();
        database.close().await;

        let error = TimeDatabase::open(path).await.err().unwrap();
        assert!(is_older_schema_error(&error), "error was {error:?}");
        // The version and the target both stay in the message: this is what
        // the fatal-launch dialog shows if the migration itself fails.
        assert!(error.contains('5') && error.contains('6'), "{error}");
        assert!(!is_older_schema_error("disk I/O error"));
    });
}

/// A live process is not evidence of a working tracker, so the health stamp
/// is what `ensure_recording_tracker` reads before it leaves one alone. The
/// three "no recent claim" spellings have to answer alike: the tracker
/// zeroes the stamp on a clean shutdown, and no stamp at all is what a
/// database that has never run one looks like.
#[test]
fn health_staleness_treats_missing_zero_and_old_stamps_alike() {
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(scratch_database("health-stale"))
            .await
            .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(database.tracker_health_is_stale(120).await.unwrap());
        for absent in ["0", "", "not-a-number"] {
            database
                .update_lifecycle_settings(&[("tracker_health_heartbeat", absent)])
                .await
                .unwrap();
            assert!(
                database.tracker_health_is_stale(120).await.unwrap(),
                "{absent:?} should read as no recent claim"
            );
        }
        let fresh = now.to_string();
        database
            .update_lifecycle_settings(&[("tracker_health_heartbeat", &fresh)])
            .await
            .unwrap();
        assert!(!database.tracker_health_is_stale(120).await.unwrap());
        let old = (now - 121).to_string();
        database
            .update_lifecycle_settings(&[("tracker_health_heartbeat", &old)])
            .await
            .unwrap();
        assert!(database.tracker_health_is_stale(120).await.unwrap());
        // A clock that moved forward is not evidence about the tracker.
        let future = (now + 3_600).to_string();
        database
            .update_lifecycle_settings(&[("tracker_health_heartbeat", &future)])
            .await
            .unwrap();
        assert!(!database.tracker_health_is_stale(120).await.unwrap());
        database.close().await;
    });
}

#[test]
fn renderer_setting_allowlist_excludes_lifecycle_and_unknown_keys() {
    assert!(TimeDatabase::validate_renderer_setting_key("theme").is_ok());
    assert!(TimeDatabase::validate_renderer_setting_key("starter_suggestions_dismissed").is_ok());
    assert!(TimeDatabase::validate_renderer_setting_key("rule_consolidation_dismissed").is_ok());
    for key in [
        "recording_consent",
        "launch_at_login",
        "tracking_schedule_enabled",
        "tracking_schedule_days",
        "tracking_schedule_start_minute",
        "tracking_schedule_end_minute",
        "tracking_paused",
        "tracking_paused_until",
        "privacy_onboarding_complete",
        "schema_version",
        "rule_priority_scheme",
        "tracker_version",
        "tracker_health_heartbeat",
        "not_a_real_setting",
    ] {
        assert!(
            TimeDatabase::validate_renderer_setting_key(key).is_err(),
            "{key} must stay behind a native boundary",
        );
    }
}

#[test]
fn user_setting_batches_are_atomic_and_keep_protected_keys_out() {
    let path = scratch_database("settings-batch-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        database
            .update_user_settings(&[
                SettingUpdate {
                    key: "theme".into(),
                    value: "dark".into(),
                },
                SettingUpdate {
                    key: "show_tray_icon".into(),
                    value: "0".into(),
                },
            ])
            .await
            .unwrap();
        let theme: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='theme'")
            .fetch_one(database.test_pool())
            .await
            .unwrap();
        assert_eq!(theme, "dark");
        let error = database
            .update_user_settings(&[
                SettingUpdate {
                    key: "theme".into(),
                    value: "light".into(),
                },
                SettingUpdate {
                    key: "recording_consent".into(),
                    value: "1".into(),
                },
            ])
            .await
            .unwrap_err();
        assert!(error.contains("native lifecycle"));
        let theme: String = sqlx::query_scalar("SELECT value FROM settings WHERE key='theme'")
            .fetch_one(database.test_pool())
            .await
            .unwrap();
        assert_eq!(theme, "dark");
        database.close().await;
    });
}

/// A fresh database is the same whichever runtime creates it. `BOOTSTRAP_SQL`
/// and the tracker's `_SCHEMA` each build one in their own suite and compare it
/// with contracts/schema.json, so a change to either copy fails in the suite of
/// the copy left behind. The Python half is tracker/tests/test_schema_contract.py.
#[test]
fn bootstrap_matches_the_schema_contract() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../../contracts/schema.json")).unwrap();
    // Comments removed and whitespace collapsed: the form the contract stores.
    let normalized = |sql: &str| {
        sql.lines()
            .map(|line| line.split("--").next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(scratch_root("schema-contract").join("database.db"))
            .await
            .unwrap();
        let objects: Vec<serde_json::Value> = database
            .select(
                "SELECT type, name, tbl_name, sql FROM sqlite_master \
                 WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
                    .into(),
                Vec::new(),
            )
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                serde_json::json!({
                    "type": row["type"],
                    "name": row["name"],
                    "table": row["tbl_name"],
                    "sql": normalized(row["sql"].as_str().unwrap_or_default()),
                })
            })
            .collect();
        assert_eq!(serde_json::Value::Array(objects), contract["objects"]);
        let categories = database
            .select("SELECT * FROM categories ORDER BY id".into(), Vec::new())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(categories).unwrap(),
            contract["categories"]
        );
        database.close().await;
    });
}

#[test]
fn website_normalization_matches_shared_contract_fixture() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        input: String,
        expected: Option<String>,
    }
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../contracts/host_normalization.json"
    ))
    .unwrap();
    for case in fixture.cases {
        let actual = normalize_website_host(&case.input).ok();
        assert_eq!(actual, case.expected, "input {:?}", case.input);
    }
}

#[test]
fn exclusions_are_normalized_and_can_atomically_delete_history() {
    let path = scratch_database("database-exclusion-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,domain) VALUES \
                 (1,10,40,'chrome.exe','example.com'),(2,40,70,'code.exe',NULL)",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        let preview = database
            .preview_tracking_exclusion("website", "https://www.Example.com/path")
            .await
            .unwrap();
        assert_eq!(
            (
                preview.normalized_pattern.as_str(),
                preview.count,
                preview.seconds
            ),
            ("example.com", 1, 30)
        );
        let result = database
            .add_tracking_exclusion("website", "https://www.Example.com/path", true)
            .await
            .unwrap();
        assert_eq!(result.deleted_count, 1);
        assert_eq!(database.list_tracking_exclusions().await.unwrap().len(), 1);
        let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
            .fetch_all(&database.pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec![2]);
        database
            .add_tracking_exclusion("app", "CODE.EXE", false)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
                .fetch_one(&database.pool)
                .await
                .unwrap(),
            1
        );
    });
}

#[test]
fn app_exclusions_supply_the_extension_sessions_are_stored_with() {
    assert_eq!(
        super::exclusions::normalize_exclusion("app", " Code ").unwrap(),
        "code.exe"
    );
    assert_eq!(
        super::exclusions::normalize_exclusion("app", "CODE.EXE").unwrap(),
        "code.exe"
    );
    // A dotted name is already specific enough to match on its own.
    assert_eq!(
        super::exclusions::normalize_exclusion("app", "vim.bat").unwrap(),
        "vim.bat"
    );
    assert!(super::exclusions::normalize_exclusion("app", "C:\\apps\\code.exe").is_err());
}

#[test]
fn corrections_overlay_raw_sessions_and_validate_timeline_rules() {
    let path = scratch_database("database-correction-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        let now = super::unix_now().unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?, 'code.exe',0),(2,?,?,'other.exe',0),(3,?,?,'afk',1)",
        )
        .bind(now - 300)
        .bind(now - 250)
        .bind(now - 200)
        .bind(now - 150)
        .bind(now - 100)
        .bind(now - 50)
        .execute(&database.pool)
        .await
        .unwrap();
        let category_id: i64 = sqlx::query_scalar("SELECT id FROM categories ORDER BY id LIMIT 1")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        let corrected = database
            .correct_session(&SessionCorrectionRequest {
                session_id: 1,
                start_sec: (now - 290) as f64,
                end_sec: (now - 240) as f64,
                category_id: Some(category_id),
            })
            .await
            .unwrap();
        assert_eq!(
            (corrected.start, corrected.end, corrected.category_id),
            (now - 290, now - 240, Some(category_id))
        );
        let raw: (i64, i64) = sqlx::query_as("SELECT start_ts,end_ts FROM sessions WHERE id=1")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        assert_eq!(raw, (now - 300, now - 250));
        let columns = database
            .fetch_sessions((now - 400) as f64, now as f64)
            .await
            .unwrap();
        assert_eq!(columns.starts[0], now - 290);
        assert_eq!(columns.category_override_ids[0], Some(category_id));
        assert!(columns.is_corrected[0]);
        let overlap = database
            .correct_session(&SessionCorrectionRequest {
                session_id: 1,
                start_sec: (now - 220) as f64,
                end_sec: (now - 180) as f64,
                category_id: None,
            })
            .await;
        assert!(overlap.unwrap_err().contains("overlap"));
        let afk = database
            .correct_session(&SessionCorrectionRequest {
                session_id: 3,
                start_sec: (now - 100) as f64,
                end_sec: (now - 50) as f64,
                category_id: None,
            })
            .await;
        assert!(afk.unwrap_err().contains("AFK"));
        assert_eq!(database.reset_session_correction(1).await.unwrap(), 1);
        assert!(
            !database
                .fetch_session_correction(1)
                .await
                .unwrap()
                .is_corrected
        );
    });
}

#[test]
fn bulk_classification_spares_recorded_times_afk_rows_and_unchanged_sessions() {
    let path = scratch_database("database-classify-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        let now = super::unix_now().unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?,'code.exe',0),(2,?,?,'code.exe',0),(3,?,?,'afk',1)",
        )
        .bind(now - 300)
        .bind(now - 250)
        .bind(now - 200)
        .bind(now - 150)
        .bind(now - 100)
        .bind(now - 50)
        .execute(&database.pool)
        .await
        .unwrap();
        let categories: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM categories ORDER BY id LIMIT 2")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        let (first, second) = (categories[0], categories[1]);

        // Session 1 carries a time correction the reclassification must not
        // disturb; session 3 is AFK and can only ever be skipped.
        database
            .correct_session(&SessionCorrectionRequest {
                session_id: 1,
                start_sec: (now - 290) as f64,
                end_sec: (now - 260) as f64,
                category_id: None,
            })
            .await
            .unwrap();
        let applied = database
            .classify_sessions(&SessionClassificationRequest {
                session_ids: vec![1, 2, 3],
                category_id: Some(first),
            })
            .await
            .unwrap();
        assert_eq!((applied.changed_count, applied.skipped_count), (2, 1));
        assert_eq!(applied.previous.len(), 2);
        let corrected = database.fetch_session_correction(1).await.unwrap();
        assert_eq!(corrected.category_id, Some(first));
        assert_eq!((corrected.start, corrected.end), (now - 290, now - 260));

        // Only what actually moves is reported: session 1 is already there.
        let partial = database
            .classify_sessions(&SessionClassificationRequest {
                session_ids: vec![1, 2],
                category_id: Some(first),
            })
            .await
            .unwrap();
        assert_eq!(partial.changed_count, 0);
        assert!(partial.previous.is_empty());

        // Undo restores each session's own prior value, not one shared one.
        database
            .classify_sessions(&SessionClassificationRequest {
                session_ids: vec![2],
                category_id: Some(second),
            })
            .await
            .unwrap();
        for entry in applied.previous {
            database
                .classify_sessions(&SessionClassificationRequest {
                    session_ids: vec![entry.session_id],
                    category_id: entry.category_id,
                })
                .await
                .unwrap();
        }
        let restored = database.fetch_session_correction(1).await.unwrap();
        assert_eq!(restored.category_id, None);
        // The time correction outlives a cleared category; session 2 had
        // nothing else to keep, so its row goes rather than sitting empty
        // and reporting the session as corrected forever.
        assert_eq!((restored.start, restored.end), (now - 290, now - 260));
        assert!(restored.is_corrected);
        assert!(
            !database
                .fetch_session_correction(2)
                .await
                .unwrap()
                .is_corrected
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM session_corrections WHERE session_id=2"
            )
            .fetch_one(&database.pool)
            .await
            .unwrap(),
            0
        );

        let empty = database
            .classify_sessions(&SessionClassificationRequest {
                session_ids: vec![],
                category_id: Some(first),
            })
            .await;
        assert!(empty.unwrap_err().contains("at least one"));
        let missing = database
            .classify_sessions(&SessionClassificationRequest {
                session_ids: vec![2],
                category_id: Some(9_999),
            })
            .await;
        assert!(missing.unwrap_err().contains("no longer exists"));
    });
}

#[test]
fn entity_rule_replacement_rolls_back_failed_writes_and_cleanup() {
    let path = scratch_database("database-entity-rule-transaction-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        sqlx::query(
            "INSERT INTO rules (id,match_type,pattern,category_id,priority) VALUES \
                 (100,'process','editor.exe',1,3),(101,'process','EDITOR.EXE',1,3),\
                 (102,'domain','editor.exe',1,2)",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        assert!(database
            .assign_entity_rule("process", "editor.exe", 999_999, 3)
            .await
            .is_err());
        // Force the second statement to fail after the upsert succeeded.
        sqlx::query(
            "CREATE TRIGGER reject_rule_cleanup BEFORE DELETE ON rules \
                 WHEN OLD.id=101 BEGIN SELECT RAISE(ABORT,'injected failure'); END",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        assert!(database
            .assign_entity_rule("process", "editor.exe", 2, 3)
            .await
            .is_err());
        let rows: Vec<(i64, i64)> =
            sqlx::query_as("SELECT id,category_id FROM rules WHERE id>=100 ORDER BY id")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(rows, vec![(100, 1), (101, 1), (102, 1)]);
        sqlx::query("DROP TRIGGER reject_rule_cleanup")
            .execute(&database.pool)
            .await
            .unwrap();
        database
            .assign_entity_rule("process", " EDITOR.EXE ", 2, 3)
            .await
            .unwrap();
        let rows: Vec<(i64, i64)> =
            sqlx::query_as("SELECT id,category_id FROM rules WHERE id>=100 ORDER BY id")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(rows, vec![(100, 2), (102, 1)]);
        assert!(database
            .assign_entity_rule("title", "editor.exe", 2, 3)
            .await
            .is_err());
        assert!(database
            .assign_entity_rule("process", " ", 2, 3)
            .await
            .is_err());
    });
}

#[test]
fn session_windows_follow_corrected_spans_not_raw_ones() {
    // fetch_sessions filters the uncorrected rows on raw end/start columns
    // so idx_sessions_end can drive them, and the corrected rows on their
    // effective spans. A correction that moves a session across a window
    // boundary is what tells those two branches apart: filtering everything
    // on raw columns would place session 1 in the wrong window, and
    // filtering everything through COALESCE would give up the index.
    let path = scratch_database("database-corrected-window-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        let now = super::unix_now().unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,is_afk) VALUES \
                 (1,?,?,'moved.exe',0),(2,?,?,'stayed.exe',0)",
        )
        .bind(now - 10_000)
        .bind(now - 9_900)
        .bind(now - 500)
        .bind(now - 400)
        .execute(&database.pool)
        .await
        .unwrap();
        // Drag session 1 forward, out of its raw window and into session 2's.
        database
            .correct_session(&SessionCorrectionRequest {
                session_id: 1,
                start_sec: (now - 300) as f64,
                end_sec: (now - 200) as f64,
                category_id: None,
            })
            .await
            .unwrap();

        let recent = database
            .fetch_sessions((now - 600) as f64, now as f64)
            .await
            .unwrap();
        assert_eq!(recent.ids, vec![2, 1], "ordered by effective start");
        assert_eq!(recent.starts, vec![now - 500, now - 300]);
        assert_eq!(recent.is_corrected, vec![false, true]);

        // Its raw span is now empty: the correction moved it out entirely.
        let raw_window = database
            .fetch_sessions((now - 10_100) as f64, (now - 9_800) as f64)
            .await
            .unwrap();
        assert!(
            raw_window.ids.is_empty(),
            "a corrected session must not answer for where its raw row sat",
        );
    });
}

#[test]
fn narrow_window_keeps_a_long_uncorrected_session_that_overlaps_its_start() {
    let path = scratch_database("database-long-session-window-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        let now = super::unix_now().unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES \
                 (1,?,?,'long-running.exe'),(2,?,?,'outside.exe')",
        )
        .bind(now - 30 * 86_400)
        .bind(now - 1)
        .bind(now - 3_000)
        .bind(now - 2_900)
        .execute(&database.pool)
        .await
        .unwrap();

        let sessions = database
            .fetch_sessions((now - 600) as f64, now as f64)
            .await
            .unwrap();
        assert_eq!(sessions.ids, vec![1]);
        assert_eq!(sessions.starts, vec![now - 30 * 86_400]);
    });
}

#[test]
fn session_window_query_keeps_both_indexed_paths() {
    let path = scratch_database("database-session-end-index-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        sqlx::query(
            "WITH RECURSIVE numbers(n) AS (\
                    SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 50000\
                 )\
                 INSERT INTO sessions (id,start_ts,end_ts,process)\
                 SELECT n,n * 60,n * 60 + 30,'history.exe' FROM numbers",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        sqlx::query("ANALYZE")
            .execute(&database.pool)
            .await
            .unwrap();

        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
            "EXPLAIN QUERY PLAN {}",
            super::sessions::FETCH_SESSIONS_SQL
        ))
        .bind(2_999_900_i64)
        .bind(3_000_000_i64)
        .fetch_all(&database.pool)
        .await
        .unwrap();
        assert!(
            plan.iter()
                .any(|(_, _, _, detail)| detail.contains("idx_sessions_end")),
            "exact-overlap query should use idx_sessions_end, plan: {plan:?}",
        );
        assert!(
            plan.iter()
                .any(|(_, _, _, detail)| detail.contains("idx_sessions_start")),
            "early-history query should use idx_sessions_start, plan: {plan:?}",
        );
        for (start, end) in [
            (0.0, 300.0),
            (1_499_900.0, 1_500_100.0),
            (2_999_900.0, 3_000_000.0),
            (-200.0, -100.0),
            (3_000_100.0, 3_000_200.0),
        ] {
            let expected: Vec<i64> = sqlx::query_scalar(
                "SELECT id FROM sessions WHERE end_ts>? AND start_ts<? ORDER BY start_ts,id",
            )
            .bind(start)
            .bind(end)
            .fetch_all(&database.pool)
            .await
            .unwrap();
            let actual = database.fetch_sessions(start, end).await.unwrap();
            assert_eq!(actual.ids, expected, "window {start}..{end}");
        }
    });
}

#[test]
fn bootstrap_stamps_the_schema_version_it_creates() {
    // The version lives twice in this file — once as the constant open()
    // enforces, once as a literal in the SQL that seeds a fresh database.
    // Bumping one and not the other makes every new database unopenable by
    // the code that just created it.
    let seeded = format!("('schema_version','{SCHEMA_VERSION}')");
    assert!(
        BOOTSTRAP_SQL.contains(&seeded),
        "BOOTSTRAP_SQL must seed schema_version {SCHEMA_VERSION}",
    );
}

#[test]
fn corrected_window_projection_matches_independent_interval_oracle() {
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(scratch_database("projection-oracle"))
            .await
            .unwrap();
        let mut effective = Vec::new();
        for id in 1_i64..=80 {
            let start = id * 100;
            let end = start + id % 70 + 1;
            sqlx::query("INSERT INTO sessions(id,start_ts,end_ts,process,is_afk) VALUES(?,?,?,'oracle.exe',?)")
                    .bind(id).bind(start).bind(end).bind(i64::from(id % 7 == 0))
                    .execute(&database.pool).await.unwrap();
            let (from, to) = if id % 3 == 0 {
                (start + 10000, end + 10000)
            } else if id % 3 == 1 {
                (start - 10000, end - 10000)
            } else {
                (start, end)
            };
            if from != start {
                sqlx::query("INSERT INTO session_corrections(session_id,corrected_start_ts,corrected_end_ts,updated_ts) VALUES(?,?,?,0)")
                        .bind(id).bind(from).bind(to).execute(&database.pool).await.unwrap();
            }
            effective.push((id, from, to));
        }
        effective.sort_by_key(|&(id, start, _)| (start, id));
        for (from, to) in [
            (-12000, 20000),
            (-10000, -9000),
            (0, 10000),
            (10000, 20000),
            (200, 203),
            (203, 300),
            (17999, 18000),
            (30000, 30100),
        ] {
            let expected: Vec<i64> = effective
                .iter()
                .filter(|&&(_, start, end)| end > from && start < to)
                .map(|&(id, _, _)| id)
                .collect();
            assert_eq!(
                database
                    .fetch_sessions(from as f64, to as f64)
                    .await
                    .unwrap()
                    .ids,
                expected
            );
        }
        database.close().await;
    });
}

/// A restore force-stops the tracker, so the live database is left exactly
/// like this one: a main file plus a log nobody folded in. The swap has to
/// delete that log — pairing it with the database that replaces it would
/// corrupt both — and deleting it before folding it in silently reverted
/// the copy kept for rollback to its last checkpoint, which on a busy day
/// is hours of recording.
#[test]
fn a_rolled_back_restore_keeps_what_the_stopped_tracker_left_in_its_log() {
    let root = scratch_root("database-restore-rollback-wal-test");
    let live = root.join("database.db");
    let origin = root.join("still-running.db");

    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        let backup = database.backup_with_name("before").await.unwrap();
        database
            .prepare_restore(PathBuf::from(backup))
            .await
            .unwrap();
        database.close().await;

        // Stand in for the tracker's last minutes: written, acknowledged,
        // and still only in the log when the process was killed.
        let source = TimeDatabase::open(origin.clone()).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (3,30,40,'unsaved.exe')",
        )
        .execute(&source.pool)
        .await
        .unwrap();
        std::fs::copy(&origin, &live).unwrap();
        std::fs::copy(
            origin.with_extension("db-wal"),
            live.with_extension("db-wal"),
        )
        .unwrap();
        source.close().await;

        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        swap.rollback().unwrap();

        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        let processes: Vec<String> = sqlx::query_scalar("SELECT process FROM sessions ORDER BY id")
            .fetch_all(&restored.pool)
            .await
            .unwrap();
        assert_eq!(processes, ["unsaved.exe"]);
        restored.close().await;
    });
}

/// A renamed database leaves its `-wal`/`-shm` behind under the old name:
/// SQLite cleans those up only for a file still where it left it. Every
/// restore renames twice, and the strays accumulated in the folder Time
/// tells the user holds their data.
#[test]
fn a_completed_restore_leaves_no_stray_files_behind() {
    let root = scratch_root("database-restore-litter-test");
    let live = root.join("database.db");

    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        let backup = database.backup_with_name("before").await.unwrap();
        database
            .prepare_restore(PathBuf::from(backup))
            .await
            .unwrap();
        database.close().await;

        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        swap.commit().unwrap();
        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        restored.close().await;
    });

    let strays: Vec<String> = std::fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("restore_"))
        .collect();
    assert!(strays.is_empty(), "restore left {strays:?} behind");
}

#[test]
fn interrupted_rollback_recovers_the_original_at_every_rename_and_cleanup_boundary() {
    for phase in 1..=4 {
        let root = scratch_root("interrupted-rollback");
        let live = root.join("database.db");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(live.clone()).await.unwrap();
            let backup = database.backup_with_name("older").await.unwrap();
            sqlx::query(
                "INSERT INTO sessions(start_ts,end_ts,process) VALUES(10,20,'original.exe')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            database
                .prepare_restore(PathBuf::from(backup))
                .await
                .unwrap();
            database.close().await;
            let swap = TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .unwrap();
            drop(swap);
            let failed = TimeDatabase::failed_restore_path(&live).unwrap();
            let previous = TimeDatabase::rollback_path(&live).unwrap();
            let marker = TimeDatabase::pending_marker_path(&live).unwrap();
            // Exact persistent states after each operation in rollback().
            TimeDatabase::rename_with_retry(&live, &failed).unwrap();
            if phase >= 2 {
                TimeDatabase::rename_with_retry(&previous, &live).unwrap();
            }
            if phase >= 3 {
                TimeDatabase::remove_if_exists(&marker).unwrap();
            }
            if phase >= 4 {
                TimeDatabase::remove_if_exists(&failed).unwrap();
            }
            for _ in 0..2 {
                assert!(TimeDatabase::begin_pending_restore(&live)
                    .await
                    .unwrap()
                    .is_none());
                let recovered = TimeDatabase::open(live.clone()).await.unwrap();
                let processes: Vec<String> = sqlx::query_scalar("SELECT process FROM sessions")
                    .fetch_all(&recovered.pool)
                    .await
                    .unwrap();
                assert_eq!(processes, ["original.exe"], "phase {phase}");
                recovered.close().await;
            }
            assert!(!previous.exists());
            assert!(!marker.exists());
            assert!(!failed.exists());
        });
    }
}

#[test]
fn interrupted_restore_after_tracker_migration_can_finish_and_restore_again() {
    let root = scratch_root("interrupted-migrated-restore");
    let live = root.join("database.db");
    let old = root.join("old.db");
    tauri::async_runtime::block_on(async {
        let source = TimeDatabase::open(old.clone()).await.unwrap();
        sqlx::query("INSERT INTO sessions(start_ts,end_ts,process) VALUES(10,20,'backup.exe')")
            .execute(&source.pool)
            .await
            .unwrap();
        sqlx::query("DROP INDEX idx_sessions_end")
            .execute(&source.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE settings SET value='4' WHERE key='schema_version'")
            .execute(&source.pool)
            .await
            .unwrap();
        source.close().await;
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        database.prepare_restore(old.clone()).await.unwrap();
        database.close().await;
        drop(
            TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .unwrap(),
        );
        // Startup migrates the swapped backup, then the host exits before
        // committing restore bookkeeping. The original marker still says 4.
        drop(RecorderProcess::start(&live));
        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(swap.pending.schema_version, SCHEMA_VERSION);
        swap.commit().unwrap();
        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        let processes: Vec<String> = sqlx::query_scalar("SELECT process FROM sessions")
            .fetch_all(&restored.pool)
            .await
            .unwrap();
        assert_eq!(processes, ["backup.exe"]);
        // No orphan rollback file may prevent the next restore.
        restored.prepare_restore(old).await.unwrap();
        restored.close().await;
        TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap()
            .rollback()
            .unwrap();
    });
}

#[test]
fn interrupted_restore_with_invalid_replacement_recovers_the_original() {
    for corrupt in [false, true] {
        let root = scratch_root("interrupted-invalid-restore");
        let live = root.join("database.db");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(live.clone()).await.unwrap();
            let backup = database.backup_with_name("empty").await.unwrap();
            sqlx::query(
                "INSERT INTO sessions(start_ts,end_ts,process) VALUES(10,20,'original.exe')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            database
                .prepare_restore(PathBuf::from(backup))
                .await
                .unwrap();
            database.close().await;
            drop(
                TimeDatabase::begin_pending_restore(&live)
                    .await
                    .unwrap()
                    .unwrap(),
            );
            if corrupt {
                std::fs::write(&live, b"interrupted or damaged replacement").unwrap();
            } else {
                let replaced = TimeDatabase::open(live.clone()).await.unwrap();
                sqlx::query("UPDATE settings SET value='999' WHERE key='schema_version'")
                    .execute(&replaced.pool)
                    .await
                    .unwrap();
                replaced.close().await;
            }
            assert!(TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .is_none());
            let recovered = TimeDatabase::open(live.clone()).await.unwrap();
            let processes: Vec<String> = sqlx::query_scalar("SELECT process FROM sessions")
                .fetch_all(&recovered.pool)
                .await
                .unwrap();
            assert_eq!(processes, ["original.exe"]);
            recovered.close().await;
            assert!(!TimeDatabase::rollback_path(&live).unwrap().exists());
        });
    }
}

#[test]
fn interrupted_restore_commit_cleans_up_before_another_restore() {
    let root = scratch_root("interrupted-restore-commit");
    let live = root.join("database.db");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        let backup = PathBuf::from(database.backup_with_name("empty").await.unwrap());
        database.prepare_restore(backup.clone()).await.unwrap();
        database.close().await;
        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        TimeDatabase::remove_if_exists(&swap.marker_path).unwrap();
        drop(swap);
        assert!(TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .is_none());
        assert!(!TimeDatabase::rollback_path(&live).unwrap().exists());
        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        restored.prepare_restore(backup).await.unwrap();
        restored.close().await;
        TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap()
            .commit()
            .unwrap();
    });
}

#[test]
fn leftover_rollback_copy_does_not_block_a_later_restore() {
    let root = scratch_root("leftover-rollback-restore");
    let live = root.join("database.db");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        let backup = database.backup_with_name("empty").await.unwrap();
        sqlx::query("INSERT INTO sessions(start_ts,end_ts,process) VALUES(10,20,'original.exe')")
            .execute(&database.pool)
            .await
            .unwrap();
        database
            .prepare_restore(PathBuf::from(backup))
            .await
            .unwrap();
        database.close().await;
        // An earlier restore committed but could not delete its rollback copy.
        std::fs::copy(&live, TimeDatabase::rollback_path(&live).unwrap()).unwrap();
        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        swap.commit().unwrap();
        assert!(!TimeDatabase::rollback_path(&live).unwrap().exists());
        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&restored.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        restored.close().await;
    });
    // Even if that copy cannot be removed, startup cancels the restore and
    // opens the intact live database instead of refusing to launch.
    let root = scratch_root("leftover-rollback-startup");
    let live = root.join("database.db");
    std::fs::write(
        TimeDatabase::pending_database_path(&live).unwrap(),
        b"staged",
    )
    .unwrap();
    std::fs::write(TimeDatabase::rollback_path(&live).unwrap(), b"leftover").unwrap();
    std::fs::write(&live, b"live").unwrap();
    assert!(!TimeDatabase::restore_needs_recovery(&live));
}

#[test]
fn interrupted_forward_swap_still_finishes_the_selected_restore() {
    for phase in 0..=2 {
        let root = scratch_root("interrupted-forward-restore");
        let live = root.join("database.db");
        tauri::async_runtime::block_on(async {
            let database = TimeDatabase::open(live.clone()).await.unwrap();
            let backup = database.backup_with_name("empty").await.unwrap();
            sqlx::query(
                "INSERT INTO sessions(start_ts,end_ts,process) VALUES(10,20,'original.exe')",
            )
            .execute(&database.pool)
            .await
            .unwrap();
            database
                .prepare_restore(PathBuf::from(backup))
                .await
                .unwrap();
            database.close().await;
            if phase >= 1 {
                TimeDatabase::rename_with_retry(
                    &live,
                    &TimeDatabase::rollback_path(&live).unwrap(),
                )
                .unwrap();
            }
            if phase >= 2 {
                TimeDatabase::rename_with_retry(
                    &TimeDatabase::pending_database_path(&live).unwrap(),
                    &live,
                )
                .unwrap();
            }
            let swap = TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .unwrap();
            swap.commit().unwrap();
            assert!(TimeDatabase::begin_pending_restore(&live)
                .await
                .unwrap()
                .is_none());
            let restored = TimeDatabase::open(live).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
                .fetch_one(&restored.pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "phase {phase}");
            restored.close().await;
        });
    }
}

/// A backup copied out of a running Time keeps its write-ahead log, and the
/// rows it holds are not in the main file yet. Restore validates through a
/// read-only connection, which cannot replay a log, so such a backup was
/// rejected as unversioned — and when it was copied, the log was left
/// behind and its rows vanished from the restored database.
#[test]
fn a_backup_carrying_a_write_ahead_log_restores_everything_it_holds() {
    let root = scratch_root("database-restore-wal-test");
    let live = root.join("database.db");
    let backup = root.join("copied-while-running.db");

    let origin = root.join("still-running.db");
    tauri::async_runtime::block_on(async {
        let source = TimeDatabase::open(origin.clone()).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (7,70,80,'kept.exe')",
        )
        .execute(&source.pool)
        .await
        .unwrap();
        // Copy while the database is still open, which is what taking a
        // backup out from under a running tracker actually produces: the
        // rows live in the log, not yet in the main file.
        std::fs::copy(&origin, &backup).unwrap();
        std::fs::copy(
            origin.with_extension("db-wal"),
            backup.with_extension("db-wal"),
        )
        .unwrap();
        source.close().await;
    });
    assert!(
        backup.with_extension("db-wal").is_file(),
        "the fixture must leave a write-ahead log for this to test anything",
    );

    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(live.clone()).await.unwrap();
        database.prepare_restore(backup.clone()).await.unwrap();
        database.close().await;

        let swap = TimeDatabase::begin_pending_restore(&live)
            .await
            .unwrap()
            .unwrap();
        swap.commit().unwrap();

        let restored = TimeDatabase::open(live.clone()).await.unwrap();
        let processes: Vec<String> = sqlx::query_scalar("SELECT process FROM sessions ORDER BY id")
            .fetch_all(&restored.pool)
            .await
            .unwrap();
        assert_eq!(processes, ["kept.exe"]);
        restored.close().await;
    });
}

#[test]
fn backup_folder_and_staged_restore_preserve_a_rollback_until_reopen() {
    let root = scratch_root("database-restore-test");
    let path = root.join("database.db");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (1,10,20,'code.exe')",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        let backup_path = PathBuf::from(
            database
                .backup_with_name("Backup 08-13-2026")
                .await
                .unwrap(),
        );
        assert_eq!(
            backup_path.parent().unwrap().file_name().unwrap(),
            "Backups"
        );
        assert_eq!(backup_path.file_name().unwrap(), "Backup 08-13-2026.db");
        assert!(database
            .list_backups()
            .await
            .unwrap()
            .iter()
            .any(|backup| backup.name == "Backup 08-13-2026.db" && backup.kind == "Manual"));
        assert!(database
            .backup_with_name("Backup 08-13-2026")
            .await
            .unwrap_err()
            .contains("already exists"));
        assert!(database
            .backup_with_name("not/a-backup")
            .await
            .unwrap_err()
            .contains("contain path"));
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (2,20,30,'mail.exe')",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        let pending = database.prepare_restore(backup_path).await.unwrap();
        assert_eq!(pending.schema_version, SCHEMA_VERSION);
        database.close().await;

        let swap = TimeDatabase::begin_pending_restore(&path)
            .await
            .unwrap()
            .unwrap();
        assert!(root.join("restore_previous.db").exists());
        let restored = TimeDatabase::open(path.clone()).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&restored.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        restored.close().await;
        swap.commit().unwrap();
        assert!(!root.join("restore_previous.db").exists());
        assert!(!root.join("restore_pending.json").exists());
    });
}

/// The restore swap renames a database the process has just closed, and
/// Windows releases that handle a moment after the close resolves. Hold a
/// genuine exclusive handle rather than simulating one: a share mode that
/// still permits deletion would let the rename through and prove nothing.
#[test]
#[cfg(windows)]
fn a_briefly_locked_file_is_renamed_once_the_handle_closes() {
    use std::os::windows::fs::OpenOptionsExt;

    let root = scratch_root("database-lock-retry-test");
    let source = root.join("locked.db");
    let destination = root.join("moved.db");
    std::fs::write(&source, b"contents").unwrap();

    let handle = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    assert!(
        std::fs::rename(&source, &destination).is_err(),
        "the handle must actually block a plain rename, or this proves nothing"
    );
    let holder = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        drop(handle);
    });

    TimeDatabase::rename_with_retry(&source, &destination).unwrap();
    holder.join().unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"contents");
    assert!(!source.exists());
}

/// A lock is worth waiting out; a missing file never becomes present, and
/// retrying one for half a second would just slow every failure down.
#[test]
fn a_failure_that_is_not_a_lock_is_reported_with_its_path() {
    let root = scratch_root("database-lock-missing-test");
    let error = TimeDatabase::rename_with_retry(&root.join("absent.db"), &root.join("target.db"))
        .unwrap_err();
    assert!(error.contains("absent.db"), "{error}");
}

#[test]
fn fresh_database_has_essential_private_defaults() {
    let path = scratch_database("database-bootstrap-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        let categories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        let rules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rules")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        let consent: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='recording_consent'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let titles: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='record_window_titles'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let tray_icon: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='show_tray_icon'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let starter_pending: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='starter_categories_pending'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let update_checks: String = sqlx::query_scalar(
            "SELECT value FROM settings WHERE key='check_updates_automatically'",
        )
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(
            (
                categories,
                rules,
                consent.as_str(),
                titles.as_str(),
                tray_icon.as_str(),
                starter_pending.as_str(),
                update_checks.as_str()
            ),
            (6, 0, "0", "0", "1", "1", "1")
        );
        // The same list test_seed_categories_and_settings_present asserts on
        // the Python side. Either half may create the database first, so the
        // two seed declarations drifting would hand one user a taxonomy the
        // other never sees — and nothing else fails when it happens.
        let seeded: Vec<(String, i64, i64, i64)> = sqlx::query_as(
                "SELECT name, is_productive, is_neutral, is_ignored FROM categories ORDER BY sort_order",
            )
            .fetch_all(&database.pool)
            .await
            .unwrap();
        let seeded: Vec<(&str, i64, i64, i64)> = seeded
            .iter()
            .map(|(name, productive, neutral, ignored)| {
                (name.as_str(), *productive, *neutral, *ignored)
            })
            .collect();
        assert_eq!(
            seeded,
            vec![
                ("Work", 1, 0, 0),
                ("Communication", 0, 1, 0),
                ("Browsing", 0, 1, 0),
                ("Entertainment", 0, 0, 0),
                ("System", 0, 1, 0),
                ("Ignored", 0, 0, 1),
            ]
        );
        database.close().await;
    });
}

#[test]
fn existing_taxonomy_does_not_receive_starter_categories() {
    let path = scratch_database("database-existing-taxonomy-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        sqlx::query("DELETE FROM categories")
            .execute(&database.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM settings WHERE key='starter_categories_pending'")
            .execute(&database.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO categories (name,color,sort_order) VALUES ('Personal','#123456',1)",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        database.close().await;

        let reopened = TimeDatabase::open(path.clone()).await.unwrap();
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM categories ORDER BY sort_order")
                .fetch_all(&reopened.pool)
                .await
                .unwrap();
        let marker: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='starter_categories_pending'")
                .fetch_optional(&reopened.pool)
                .await
                .unwrap();
        assert_eq!(names, vec!["Personal"]);
        assert_eq!(marker, None);
        reopened.close().await;
    });
}

#[test]
fn session_read_is_columnar_ordered_and_windowed() {
    let path = scratch_database("database-session-columns-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        for values in [
            (1_i64, 50_i64, 60_i64, "first.exe", 0_i64),
            (2, 20, 30, "second.exe", 1),
            (3, 150, 160, "outside.exe", 0),
        ] {
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,title,is_afk) \
                     VALUES (?,?,?,?,?,?)",
            )
            .bind(values.0)
            .bind(values.1)
            .bind(values.2)
            .bind(values.3)
            .bind("")
            .bind(values.4)
            .execute(&database.pool)
            .await
            .unwrap();
        }

        let sessions = database.fetch_sessions(10.0, 100.0).await.unwrap();
        assert_eq!(sessions.ids, vec![2, 1]);
        assert_eq!(sessions.starts, vec![20, 50]);
        assert_eq!(sessions.ends, vec![30, 60]);
        assert_eq!(sessions.processes, vec!["second.exe", "first.exe"]);
        assert_eq!(sessions.is_afk, vec![true, false]);
    });
}

#[test]
fn activity_delete_is_exact_and_snapshot_bounded() {
    let path = scratch_database("database-activity-delete-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        for values in [
            (1_i64, "chrome.exe", Some("example.com")),
            (2, "chrome.exe", Some("other.com")),
            (3, "chrome.exe", None),
            (4, "code.exe", None),
        ] {
            sqlx::query(
                "INSERT INTO sessions (id,start_ts,end_ts,process,domain) VALUES (?,?,?, ?,?)",
            )
            .bind(values.0)
            .bind(values.0 * 20)
            .bind(values.0 * 20 + 10)
            .bind(values.1)
            .bind(values.2)
            .execute(&database.pool)
            .await
            .unwrap();
        }
        let mut request = ActivityDeleteRequest {
            mode: "entity".into(),
            session_ids: vec![],
            entity_kind: Some("website".into()),
            entity_key: Some("example.com".into()),
            start_sec: Some(0.0),
            end_sec: Some(1_000.0),
            browser_processes: vec!["chrome.exe".into()],
            snapshot_max_id: None,
            preview_protected_session_id: None,
        };
        let preview = database.preview_activity_delete(&request).await.unwrap();
        assert_eq!(
            (preview.count, preview.seconds, preview.snapshot_max_id),
            (1, 10, 4)
        );

        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,domain) \
                 VALUES (5,100,110,'chrome.exe','example.com')",
        )
        .execute(&database.pool)
        .await
        .unwrap();
        request.snapshot_max_id = Some(preview.snapshot_max_id);
        request.preview_protected_session_id = preview.protected_session_id;
        let deleted = database.delete_activity(&request).await.unwrap();
        assert_eq!(deleted.deleted_count, 1);
        let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
            .fetch_all(&database.pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec![2, 3, 4, 5]);

        let app_preview = database
            .preview_activity_delete(&ActivityDeleteRequest {
                mode: "entity".into(),
                session_ids: vec![],
                entity_kind: Some("app".into()),
                entity_key: Some("chrome.exe".into()),
                start_sec: Some(0.0),
                end_sec: Some(1_000.0),
                browser_processes: vec!["chrome.exe".into()],
                snapshot_max_id: None,
                preview_protected_session_id: None,
            })
            .await
            .unwrap();
        assert_eq!(app_preview.count, 1);

        let mut selected_request = ActivityDeleteRequest {
            mode: "sessions".into(),
            session_ids: vec![2, 4, 999],
            entity_kind: None,
            entity_key: None,
            start_sec: None,
            end_sec: None,
            browser_processes: vec![],
            snapshot_max_id: None,
            preview_protected_session_id: None,
        };
        let selected_preview = database
            .preview_activity_delete(&selected_request)
            .await
            .unwrap();
        assert_eq!((selected_preview.count, selected_preview.seconds), (2, 20));
        selected_request.snapshot_max_id = Some(selected_preview.snapshot_max_id);
        selected_request.preview_protected_session_id = selected_preview.protected_session_id;
        let selected_deleted = database.delete_activity(&selected_request).await.unwrap();
        assert_eq!(selected_deleted.deleted_count, 2);
        let selected_remaining: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM sessions ORDER BY id")
                .fetch_all(&database.pool)
                .await
                .unwrap();
        assert_eq!(selected_remaining, vec![3, 5]);
        let free_pages: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        assert_eq!(free_pages, 0);
    });
}

#[test]
fn targeted_and_retention_deletion_reject_a_newer_schema() {
    let path = scratch_database("database-activity-newer-schema-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path.clone()).await.unwrap();
        sqlx::query("UPDATE settings SET value='999' WHERE key='schema_version'")
            .execute(&database.pool)
            .await
            .unwrap();
        database.close().await;

        let newer = TimeDatabase::open(path).await.unwrap();
        let request = ActivityDeleteRequest {
            mode: "sessions".into(),
            session_ids: vec![1],
            entity_kind: None,
            entity_key: None,
            start_sec: None,
            end_sec: None,
            browser_processes: vec![],
            snapshot_max_id: Some(1),
            preview_protected_session_id: None,
        };
        assert!(newer.delete_activity(&request).await.is_err());
        assert!(newer.delete_history_before(100.0).await.is_err());
    });
}

#[test]
fn activity_delete_protects_the_recent_live_edge() {
    let path = scratch_database("database-activity-live-edge-test");
    tauri::async_runtime::block_on(async {
        let database = TimeDatabase::open(path).await.unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        sqlx::query(
            "INSERT INTO sessions (id,start_ts,end_ts,process,source) \
                 VALUES (1,?,?, 'code.exe','live')",
        )
        .bind(now - 20)
        .bind(now)
        .execute(&database.pool)
        .await
        .unwrap();
        sqlx::query("UPDATE settings SET value='1' WHERE key='recording_consent'")
            .execute(&database.pool)
            .await
            .unwrap();
        let mut request = ActivityDeleteRequest {
            mode: "sessions".into(),
            session_ids: vec![1],
            entity_kind: None,
            entity_key: None,
            start_sec: None,
            end_sec: None,
            browser_processes: vec![],
            snapshot_max_id: None,
            preview_protected_session_id: None,
        };
        let protected = database.preview_activity_delete(&request).await.unwrap();
        assert_eq!((protected.count, protected.protected_count), (0, 1));

        sqlx::query("UPDATE settings SET value='1' WHERE key='tracking_paused'")
            .execute(&database.pool)
            .await
            .unwrap();
        request.snapshot_max_id = Some(protected.snapshot_max_id);
        request.preview_protected_session_id = protected.protected_session_id;
        let unchanged = database.delete_activity(&request).await.unwrap();
        assert_eq!((unchanged.deleted_count, unchanged.protected_count), (0, 1));
        let still_present: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id=1")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        assert_eq!(still_present, 1);

        request.snapshot_max_id = None;
        request.preview_protected_session_id = None;
        let paused = database.preview_activity_delete(&request).await.unwrap();
        assert_eq!((paused.count, paused.protected_count), (1, 0));
        request.snapshot_max_id = Some(paused.snapshot_max_id);
        request.preview_protected_session_id = paused.protected_session_id;
        let deleted = database.delete_activity(&request).await.unwrap();
        assert_eq!(deleted.deleted_count, 1);
    });
}

#[test]
fn recording_schedule_handles_daytime_and_overnight_windows() {
    assert!(schedule_allows_local(
        true,
        "0,1,2,3,4",
        "540",
        "1020",
        0,
        540
    ));
    assert!(!schedule_allows_local(
        true,
        "0,1,2,3,4",
        "540",
        "1020",
        0,
        1020
    ));
    assert!(schedule_allows_local(true, "0", "1320", "360", 0, 1380));
    assert!(schedule_allows_local(true, "0", "1320", "360", 1, 359));
    assert!(!schedule_allows_local(true, "0", "1320", "360", 1, 360));
}

#[test]
fn recording_schedule_fails_closed_when_enabled_but_invalid() {
    assert!(!schedule_allows_local(true, "", "540", "1020", 0, 600));
    assert!(!schedule_allows_local(true, "0", "540", "540", 0, 600));
    assert!(schedule_allows_local(false, "", "540", "540", 0, 600));
}

async fn early_beta_marker(database: &TimeDatabase) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key='early_beta'")
        .fetch_optional(&database.pool)
        .await
        .unwrap()
}

async fn insert_session_at(database: &TimeDatabase, id: i64, start_ts: i64, process: &str) {
    sqlx::query("INSERT INTO sessions (id,start_ts,end_ts,process) VALUES (?,?,?,?)")
        .bind(id)
        .bind(start_ts)
        .bind(start_ts + 60)
        .bind(process)
        .execute(&database.pool)
        .await
        .unwrap();
}

#[test]
fn early_beta_marker_is_decided_by_the_first_session_against_the_cutoff() {
    tauri::async_runtime::block_on(async {
        let cutoff = TimeDatabase::early_beta_cutoff_ts();
        let database = TimeDatabase::open(scratch_database("early-beta-cutoff"))
            .await
            .unwrap();

        database.record_early_beta().await.unwrap();
        assert_eq!(early_beta_marker(&database).await, None, "no history yet");

        insert_session_at(&database, 1, cutoff, "later.exe").await;
        database.record_early_beta().await.unwrap();
        assert_eq!(
            early_beta_marker(&database).await,
            None,
            "the first second after the cutoff day is too late"
        );

        insert_session_at(&database, 2, cutoff - 1, "earlier.exe").await;
        database.record_early_beta().await.unwrap();
        database.record_early_beta().await.unwrap();
        assert_eq!(early_beta_marker(&database).await.as_deref(), Some("1"));

        // A stale renderer must not be able to grant or revoke it.
        for value in ["0", "1"] {
            assert!(database
                .update_user_settings(&[SettingUpdate {
                    key: "early_beta".into(),
                    value: value.into(),
                }])
                .await
                .is_err());
        }
        database.close().await;
    });
}

#[test]
fn early_beta_marker_is_recorded_before_any_history_deletion_and_survives_resets() {
    tauri::async_runtime::block_on(async {
        let early = TimeDatabase::early_beta_cutoff_ts() - 30 * 86_400;
        let far_future = (TimeDatabase::early_beta_cutoff_ts() + 3_650 * 86_400) as f64;

        // Each deletion path starts from early history with no marker yet,
        // which is the state of every early install the first time it runs
        // a release that knows about the marker.
        let older_than = TimeDatabase::open(scratch_database("early-beta-older-than"))
            .await
            .unwrap();
        insert_session_at(&older_than, 1, early, "editor.exe").await;
        assert_eq!(
            older_than.delete_history_before(far_future).await.unwrap(),
            1
        );
        assert_eq!(early_beta_marker(&older_than).await.as_deref(), Some("1"));
        older_than.restore_default_settings().await.unwrap();
        assert_eq!(early_beta_marker(&older_than).await.as_deref(), Some("1"));
        older_than.close().await;

        let erased = TimeDatabase::open(scratch_database("early-beta-erase"))
            .await
            .unwrap();
        insert_session_at(&erased, 1, early, "editor.exe").await;
        assert_eq!(erased.erase_history().await.unwrap(), 1);
        assert_eq!(early_beta_marker(&erased).await.as_deref(), Some("1"));
        erased.close().await;

        let selected = TimeDatabase::open(scratch_database("early-beta-selected"))
            .await
            .unwrap();
        insert_session_at(&selected, 1, early, "editor.exe").await;
        let mut request = ActivityDeleteRequest {
            mode: "sessions".into(),
            session_ids: vec![1],
            entity_kind: None,
            entity_key: None,
            start_sec: None,
            end_sec: None,
            browser_processes: vec![],
            snapshot_max_id: None,
            preview_protected_session_id: None,
        };
        let preview = selected.preview_activity_delete(&request).await.unwrap();
        request.snapshot_max_id = Some(preview.snapshot_max_id);
        assert_eq!(
            selected
                .delete_activity(&request)
                .await
                .unwrap()
                .deleted_count,
            1
        );
        assert_eq!(early_beta_marker(&selected).await.as_deref(), Some("1"));
        selected.close().await;

        let excluded = TimeDatabase::open(scratch_database("early-beta-exclusion"))
            .await
            .unwrap();
        insert_session_at(&excluded, 1, early, "editor.exe").await;
        excluded
            .add_tracking_exclusion("app", "editor.exe", true)
            .await
            .unwrap();
        assert_eq!(early_beta_marker(&excluded).await.as_deref(), Some("1"));
        excluded.close().await;
    });
}

//! The boundary for SQL that arrives from the webview through `db_execute` and
//! `db_select`. Read both functions before changing either.

use super::*;

impl TimeDatabase {
    /// First gate: the statement is a single one, of an allowed verb, with no
    /// way to reach outside the current database.
    ///
    /// Rejecting `;` and comment markers is what makes the single-verb check
    /// meaningful — without it, `SELECT 1; DROP TABLE sessions` passes as a
    /// SELECT, and a comment can hide a second statement from the eye without
    /// hiding it from SQLite. ATTACH/DETACH would reach other files,
    /// LOAD_EXTENSION would load code, and PRAGMA/VACUUM would let the webview
    /// change durability or rewrite the file. The prefix check catches the
    /// `load_extension`-style variants of each.
    ///
    /// This is a keyword denylist over a fixed set of queries this app issues,
    /// not a SQL parser. Widening `allowed` means re-reading it in that light.
    pub(super) fn validate_sql(query: &str, allowed: &[&str]) -> Result<(), String> {
        let trimmed = query.trim();
        let upper = trimmed.to_ascii_uppercase();
        let verb = upper.split_whitespace().next().unwrap_or("");
        if !allowed.contains(&verb) {
            return Err(format!("SQL operation {verb:?} is not allowed"));
        }
        if trimmed.contains(';') || upper.contains("--") || upper.contains("/*") {
            return Err("Multiple statements and SQL comments are not allowed".into());
        }
        for forbidden in ["ATTACH", "DETACH", "PRAGMA", "LOAD_EXTENSION", "VACUUM"] {
            if upper
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .any(|token| token == forbidden || token.starts_with(&format!("{forbidden}_")))
            {
                return Err(format!(
                    "SQL keyword {forbidden} is not allowed from the webview"
                ));
            }
        }
        Ok(())
    }

    /// Second gate: which tables the webview may write, per verb.
    ///
    /// Settings are deliberately absent. They cross a structured native
    /// command so a batch can be validated completely and committed in one
    /// transaction, while lifecycle-owned keys cannot be changed by a stale
    /// renderer or a malformed SQL request. Session deletion uses fixed,
    /// structured native commands instead of renderer-authored SQL; the tracker
    /// remains the sole author of session rows.
    ///
    /// The shape match reads the target table positionally, so a statement it
    /// cannot parse is rejected rather than allowed by default.
    pub(super) fn validate_mutation_target(query: &str) -> Result<(), String> {
        let words = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_uppercase)
            .collect::<Vec<_>>();
        // Statement shape and the tables it may touch are kept together so an
        // unrecognized SQL shape is rejected rather than allowed by default.
        let (target, allowed_tables): (&str, &[&str]) = match words.as_slice() {
            [verb, into, table, ..] if verb == "INSERT" && into == "INTO" => {
                (table.as_str(), &["RULES", "CATEGORIES"])
            }
            [verb, table, ..] if verb == "UPDATE" => (table.as_str(), &["RULES", "CATEGORIES"]),
            [verb, from, table, ..] if verb == "DELETE" && from == "FROM" => {
                (table.as_str(), &["RULES", "CATEGORIES"])
            }
            _ => return Err("Unsupported SQL mutation shape".into()),
        };
        if !allowed_tables.contains(&target) {
            return Err(format!(
                "Webview mutations of table {target:?} are not allowed"
            ));
        }
        Ok(())
    }
}

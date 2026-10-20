//! Category assignments made from an app or website row, with exact undo.

use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRuleAssignment {
    pub match_type: String,
    pub pattern: String,
    pub category_id: i64,
    pub priority: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntityRuleSnapshot {
    id: i64,
    pattern: String,
    category_id: i64,
    priority: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRuleChange {
    match_type: String,
    pattern: String,
    before: Vec<EntityRuleSnapshot>,
    after: Vec<EntityRuleSnapshot>,
}

async fn entity_rule_snapshot(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    match_type: &str,
    pattern: &str,
) -> Result<Vec<EntityRuleSnapshot>, String> {
    let rows = sqlx::query_as::<_, (i64, String, i64, i64)>(
        "SELECT id,pattern,category_id,priority FROM rules WHERE match_type=? AND lower(pattern)=? ORDER BY id",
    ).bind(match_type).bind(pattern).fetch_all(&mut **transaction).await
        .map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, pattern, category_id, priority)| EntityRuleSnapshot {
            id,
            pattern,
            category_id,
            priority,
        })
        .collect())
}

impl TimeDatabase {
    pub async fn assign_entity_rule(
        &self,
        match_type: &str,
        pattern: &str,
        category_id: i64,
        priority: i64,
    ) -> Result<EntityRuleChange, String> {
        let mut changes = self
            .assign_entity_rules(vec![EntityRuleAssignment {
                match_type: match_type.into(),
                pattern: pattern.into(),
                category_id,
                priority,
            }])
            .await?;
        Ok(changes.remove(0))
    }

    pub async fn assign_entity_rules(
        &self,
        assignments: Vec<EntityRuleAssignment>,
    ) -> Result<Vec<EntityRuleChange>, String> {
        self.ensure_writable_schema()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut changes = Vec::new();
        let mut seen = HashSet::new();
        for assignment in assignments {
            let match_type = assignment.match_type.as_str();
            let pattern = assignment.pattern.trim().to_lowercase();
            if !matches!(match_type, "process" | "domain")
                || pattern.is_empty()
                || !seen.insert((match_type.to_owned(), pattern.clone()))
            {
                return Err("Invalid or repeated entity rule".into());
            }
            let before = entity_rule_snapshot(&mut transaction, match_type, &pattern).await?;
            // Keep the canonical rule's identity when possible. Legacy case variants
            // are removed in the same transaction, so a failed replacement never
            // leaves an entity unclassified or exposes half-finished cleanup.
            sqlx::query(
                "INSERT INTO rules (match_type,pattern,category_id,priority) VALUES (?,?,?,?) \
             ON CONFLICT(match_type,pattern,scope_kind,scope_value,title_match_mode,title_anchor) \
             DO UPDATE SET category_id=excluded.category_id,priority=excluded.priority",
            )
            .bind(match_type)
            .bind(&pattern)
            .bind(assignment.category_id)
            .bind(assignment.priority)
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
            sqlx::query("DELETE FROM rules WHERE match_type=? AND lower(pattern)=? AND pattern<>?")
                .bind(match_type)
                .bind(&pattern)
                .bind(&pattern)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?;
            let after = entity_rule_snapshot(&mut transaction, match_type, &pattern).await?;
            changes.push(EntityRuleChange {
                match_type: match_type.into(),
                pattern,
                before,
                after,
            });
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        Ok(changes)
    }

    pub async fn undo_entity_rules(&self, changes: Vec<EntityRuleChange>) -> Result<(), String> {
        self.ensure_writable_schema()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        let mut seen = HashSet::new();
        for change in changes {
            if !matches!(change.match_type.as_str(), "process" | "domain")
                || !seen.insert((change.match_type.clone(), change.pattern.clone()))
            {
                return Err("Invalid classification undo".into());
            }
            // Check and restore in the same transaction. A later edit (including
            // one committed before its UI refresh) must survive an older Undo.
            if entity_rule_snapshot(&mut transaction, &change.match_type, &change.pattern).await?
                != change.after
            {
                return Err(
                    "These classifications changed after this action; Undo was canceled.".into(),
                );
            }
            sqlx::query("DELETE FROM rules WHERE match_type=? AND lower(pattern)=?")
                .bind(&change.match_type)
                .bind(&change.pattern)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?;
            for rule in change.before {
                // Old IDs may have been reused after canonicalizing case variants.
                // Restore meaning without overwriting a different row's identity.
                sqlx::query(
                    "INSERT INTO rules(match_type,pattern,category_id,priority) VALUES(?,?,?,?)",
                )
                .bind(&change.match_type)
                .bind(rule.pattern)
                .bind(rule.category_id)
                .bind(rule.priority)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
    }
}

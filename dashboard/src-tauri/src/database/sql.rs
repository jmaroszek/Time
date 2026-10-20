//! The webview's generic SQL passthrough, behind the checks in `guard`.

use super::*;
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{Column, Row, TypeInfo, Value, ValueRef};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: JsonValue,
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>, String> {
    Ok(match value {
        JsonValue::Null => query.bind(Option::<String>::None),
        JsonValue::String(value) => query.bind(value),
        JsonValue::Bool(value) => query.bind(value),
        JsonValue::Number(value) => {
            if let Some(integer) = value.as_i64() {
                query.bind(integer)
            } else if let Some(float) = value.as_f64() {
                query.bind(float)
            } else {
                return Err("Unsupported numeric SQL parameter".into());
            }
        }
        JsonValue::Array(_) | JsonValue::Object(_) => {
            return Err("Structured JSON cannot be used as a SQL parameter".into());
        }
    })
}

fn sqlite_value_to_json(raw: sqlx::sqlite::SqliteValueRef<'_>) -> Result<JsonValue, String> {
    if raw.is_null() {
        return Ok(JsonValue::Null);
    }
    match raw.type_info().name() {
        "TEXT" => raw
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .map_err(|error| error.to_string()),
        "REAL" => raw
            .to_owned()
            .try_decode::<f64>()
            .map(JsonValue::from)
            .map_err(|error| error.to_string()),
        "INTEGER" | "NUMERIC" | "BOOLEAN" => raw
            .to_owned()
            .try_decode::<i64>()
            .map(JsonValue::from)
            .map_err(|error| error.to_string()),
        "BLOB" => raw
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| JsonValue::Array(bytes.into_iter().map(JsonValue::from).collect()))
            .map_err(|error| error.to_string()),
        other => Err(format!("Unsupported SQLite result type: {other}")),
    }
}

impl TimeDatabase {
    pub async fn select(
        &self,
        query_text: String,
        values: Vec<JsonValue>,
    ) -> Result<Vec<Map<String, JsonValue>>, String> {
        Self::validate_sql(&query_text, &["SELECT"])?;
        let mut query = sqlx::query(&query_text);
        for value in values {
            query = bind_value(query, value)?;
        }
        let rows = query
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        rows.into_iter()
            .map(|row| {
                let mut out = Map::new();
                for (index, column) in row.columns().iter().enumerate() {
                    let raw = row.try_get_raw(index).map_err(|error| error.to_string())?;
                    out.insert(column.name().to_owned(), sqlite_value_to_json(raw)?);
                }
                Ok(out)
            })
            .collect()
    }

    pub async fn execute(
        &self,
        query_text: String,
        values: Vec<JsonValue>,
    ) -> Result<ExecuteResult, String> {
        self.ensure_writable_schema()?;
        Self::validate_sql(&query_text, &["INSERT", "UPDATE", "DELETE"])?;
        Self::validate_mutation_target(&query_text)?;
        let mut query = sqlx::query(&query_text);
        for value in values {
            query = bind_value(query, value)?;
        }
        let result = query
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(ExecuteResult {
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_rowid(),
        })
    }
}

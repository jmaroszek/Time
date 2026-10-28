//! Apps and websites the tracker must not record, and their normalization.

use super::*;
use serde::Serialize;
use sqlx::Row;
use std::net::IpAddr;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusion {
    pub kind: String,
    pub pattern: String,
    pub created_ts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusionPreview {
    pub count: u64,
    pub seconds: i64,
    pub normalized_pattern: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingExclusionResult {
    pub normalized_pattern: String,
    pub deleted_count: u64,
}

pub(super) fn normalize_exclusion(kind: &str, raw: &str) -> Result<String, String> {
    let mut normalized = raw.trim().to_ascii_lowercase();
    match kind {
        "app" => {
            if normalized.is_empty()
                || normalized.len() > 255
                || normalized.contains('/')
                || normalized.contains('\\')
            {
                return Err("Enter an executable name such as code.exe".into());
            }
            // Exclusions match stored process names exactly, so a bare "code"
            // would silently never fire. The caller shows the normalized
            // pattern back, so the added suffix is visible rather than magic.
            if !normalized.contains('.') {
                normalized.push_str(".exe");
            }
        }
        "website" => return normalize_website_host(raw),
        _ => return Err("Unsupported tracking exclusion kind".into()),
    }
    Ok(normalized)
}

fn invalid_website_host() -> String {
    "Enter a website such as example.com".into()
}

fn valid_port(raw: &str) -> bool {
    if raw.is_empty() || !raw.chars().all(|character| character.is_ascii_digit()) {
        return false;
    }
    let significant = raw.trim_start_matches('0');
    significant.is_empty()
        || (significant.len() <= 5 && significant.parse::<u32>().is_ok_and(|port| port <= 65_535))
}

fn trim_contract_whitespace(value: &str) -> &str {
    value.trim_matches(|character: char| {
        matches!(
            character,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

/// Normalize the host portion of a user-entered website identity.  This is
/// deliberately a small parser rather than URL parsing: the dashboard needs a
/// stable host identity and must reject ambiguous text instead of guessing
/// which colons, brackets or path characters the user meant.
pub(super) fn normalize_website_host(raw: &str) -> Result<String, String> {
    let value = trim_contract_whitespace(raw).to_ascii_lowercase();
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid_website_host());
    }

    let scheme_separator = value
        .find("://")
        .filter(|separator| !value[..*separator].contains(['/', '?', '#']));
    let without_scheme = if let Some(separator) = scheme_separator {
        let scheme = &value[..separator];
        let mut characters = scheme.chars();
        if !characters
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
            || !characters.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
            })
        {
            return Err(invalid_website_host());
        }
        &value[separator + 3..]
    } else {
        value.as_str()
    };
    let authority_end = without_scheme
        .find(['/', '?', '#'])
        .unwrap_or(without_scheme.len());
    let authority = &without_scheme[..authority_end];
    let host_port = authority.rsplit('@').next().unwrap_or("");
    if host_port.is_empty() {
        return Err(invalid_website_host());
    }

    let host = if host_port.starts_with('[') {
        let close = host_port.find(']').ok_or_else(invalid_website_host)?;
        let address = &host_port[1..close];
        let parsed = address
            .parse::<IpAddr>()
            .ok()
            .filter(IpAddr::is_ipv6)
            .ok_or_else(invalid_website_host)?;
        let suffix = &host_port[close + 1..];
        if !suffix.is_empty() {
            if !suffix.starts_with(':') || !valid_port(&suffix[1..]) {
                return Err(invalid_website_host());
            }
        }
        return Ok(parsed.to_string());
    } else {
        if host_port.contains(['[', ']']) {
            return Err(invalid_website_host());
        }
        if host_port.matches(':').count() > 1 {
            // A bare IPv6 address has many colons and no port.  A host plus a
            // port must use brackets, so anything that is not a valid IPv6
            // address is rejected rather than split heuristically.
            return host_port
                .parse::<IpAddr>()
                .ok()
                .filter(IpAddr::is_ipv6)
                .map(|parsed| parsed.to_string())
                .ok_or_else(invalid_website_host);
        }
        if let Some(colon) = host_port.find(':') {
            let candidate = &host_port[..colon];
            if !valid_port(&host_port[colon + 1..]) {
                return Err(invalid_website_host());
            }
            candidate
        } else {
            host_port
        }
    };

    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() || host.ends_with('.') {
        return Err(invalid_website_host());
    }
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.is_empty() || host.len() > 253 {
        return Err(invalid_website_host());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(address.to_string());
    }
    // A dotted all-numeric candidate is an IP address claim, not a DNS name;
    // accepting it as DNS would silently turn malformed addresses into rules
    // that never match what the tracker records.
    if host
        .chars()
        .all(|character| character.is_ascii_digit() || character == '.')
    {
        return Err(invalid_website_host());
    }
    if host != "localhost" && !host.contains('.') {
        return Err(invalid_website_host());
    }
    if host.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    }) {
        return Err(invalid_website_host());
    }
    Ok(host.to_owned())
}

impl TimeDatabase {
    pub async fn list_tracking_exclusions(&self) -> Result<Vec<TrackingExclusion>, String> {
        let rows = sqlx::query(
            "SELECT kind,pattern,created_ts FROM tracking_exclusions ORDER BY kind,pattern",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        rows.into_iter()
            .map(|row| {
                Ok(TrackingExclusion {
                    kind: row.try_get("kind").map_err(|error| error.to_string())?,
                    pattern: row.try_get("pattern").map_err(|error| error.to_string())?,
                    created_ts: row
                        .try_get("created_ts")
                        .map_err(|error| error.to_string())?,
                })
            })
            .collect()
    }

    pub async fn preview_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
    ) -> Result<TrackingExclusionPreview, String> {
        let normalized = normalize_exclusion(kind, pattern)?;
        let predicate = match kind {
            "app" => "lower(s.process)=?",
            "website" => "lower(IFNULL(s.domain,''))=?",
            _ => return Err("Unsupported tracking exclusion kind".into()),
        };
        let sql = format!(
            "SELECT COUNT(*) AS n,COALESCE(SUM(MAX(0,COALESCE(c.corrected_end_ts,s.end_ts)- \
             COALESCE(c.corrected_start_ts,s.start_ts))),0) AS seconds \
             {CORRECTED_JOIN} WHERE {predicate}"
        );
        let row = sqlx::query(&sql)
            .bind(&normalized)
            .fetch_one(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(TrackingExclusionPreview {
            count: row
                .try_get::<i64, _>("n")
                .map_err(|error| error.to_string())? as u64,
            seconds: row.try_get("seconds").map_err(|error| error.to_string())?,
            normalized_pattern: normalized,
        })
    }

    pub async fn add_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
        delete_history: bool,
    ) -> Result<TrackingExclusionResult, String> {
        self.ensure_writable_schema()?;
        let normalized = normalize_exclusion(kind, pattern)?;
        if delete_history {
            self.record_early_beta().await?;
        }
        let now = unix_now()?;
        let mut transaction = self.pool.begin().await.map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO tracking_exclusions (kind,pattern,created_ts) VALUES (?,?,?) \
             ON CONFLICT(kind,pattern) DO NOTHING",
        )
        .bind(kind)
        .bind(&normalized)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        let deleted_count = if delete_history {
            let sql = match kind {
                "app" => "DELETE FROM sessions WHERE lower(process)=?",
                "website" => "DELETE FROM sessions WHERE lower(IFNULL(domain,''))=?",
                _ => return Err("Unsupported tracking exclusion kind".into()),
            };
            sqlx::query(sql)
                .bind(&normalized)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?
                .rows_affected()
        } else {
            0
        };
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())?;
        if deleted_count > 0 {
            self.compact().await?;
        }
        Ok(TrackingExclusionResult {
            normalized_pattern: normalized,
            deleted_count,
        })
    }

    pub async fn remove_tracking_exclusion(
        &self,
        kind: &str,
        pattern: &str,
    ) -> Result<u64, String> {
        self.ensure_writable_schema()?;
        let normalized = normalize_exclusion(kind, pattern)?;
        sqlx::query("DELETE FROM tracking_exclusions WHERE kind=? AND pattern=?")
            .bind(kind)
            .bind(normalized)
            .execute(&self.pool)
            .await
            .map(|result| result.rows_affected())
            .map_err(|error| error.to_string())
    }
}

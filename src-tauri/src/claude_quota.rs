//! Read-only Claude subscription limits (5-hour and weekly), the same figures
//! Claude Code's `/usage` shows.
//!
//! The Claude Code OAuth login is read from the macOS Keychain item
//! `Claude Code-credentials`, or from `<config>/.credentials.json` on Windows
//! and Linux. The token is kept in memory only, never logged, written,
//! refreshed or synced. An expired login is reported, not renewed: Claude Code
//! owns its credentials.
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MIN_REFRESH: Duration = Duration::from_secs(55);
const FAILURE_BACKOFF: Duration = Duration::from_secs(15 * 60);
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaWindow {
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuota {
    /// ok | stale | signed_out | unavailable
    pub status: &'static str,
    pub five_hour: Option<ClaudeQuotaWindow>,
    pub seven_day: Option<ClaudeQuotaWindow>,
    pub seven_day_opus: Option<ClaudeQuotaWindow>,
    pub seven_day_sonnet: Option<ClaudeQuotaWindow>,
    pub plan: Option<String>,
    pub observed_at: Option<String>,
    pub message: Option<&'static str>,
}

impl ClaudeQuota {
    fn failure(status: &'static str, message: &'static str) -> Self {
        Self {
            status,
            five_hour: None,
            seven_day: None,
            seven_day_opus: None,
            seven_day_sonnet: None,
            plan: None,
            observed_at: None,
            message: Some(message),
        }
    }
}

struct Credential {
    token: String,
    expires_at_ms: Option<i64>,
    plan: Option<String>,
}

impl Credential {
    fn is_expired(&self) -> bool {
        self.expires_at_ms
            .is_some_and(|expires| expires <= chrono::Utc::now().timestamp_millis())
    }
}

#[derive(Default)]
struct QuotaState {
    credential: Option<Credential>,
    last_good: Option<ClaudeQuota>,
    last_attempt: Option<Instant>,
    last_result: Option<ClaudeQuota>,
    backoff_until: Option<Instant>,
}

static STATE: Mutex<Option<QuotaState>> = Mutex::new(None);

fn parse_credential(raw: &str) -> Option<Credential> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let oauth = value.get("claudeAiOauth").unwrap_or(&value);
    let token = oauth.get("accessToken")?.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    Some(Credential {
        token: token.to_string(),
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_i64),
        plan: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(|plan| plan.chars().take(32).collect()),
    })
}

fn credential_files() -> Vec<PathBuf> {
    crate::claude_usage::config_roots()
        .into_iter()
        .map(|root| root.join(".credentials.json"))
        .collect()
}

#[cfg(target_os = "macos")]
async fn read_keychain() -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

#[cfg(not(target_os = "macos"))]
async fn read_keychain() -> Option<String> {
    None
}

async fn load_credential() -> Option<Credential> {
    if let Some(credential) = read_keychain().await.as_deref().and_then(parse_credential) {
        return Some(credential);
    }
    credential_files()
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .find_map(|raw| parse_credential(&raw))
}

fn percent(value: &Value) -> Option<f64> {
    let number = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    number.is_finite().then(|| number.clamp(0.0, 100.0))
}

fn window(usage: &Value, key: &str) -> Option<ClaudeQuotaWindow> {
    let item = usage.get(key)?;
    let used_percent = percent(item.get("utilization")?)?;
    let resets_at = item
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc).to_rfc3339());
    Some(ClaudeQuotaWindow {
        used_percent,
        resets_at,
    })
}

pub fn parse_usage(
    usage: &Value,
    plan: Option<String>,
    observed_at: String,
) -> Option<ClaudeQuota> {
    let five_hour = window(usage, "five_hour");
    let seven_day = window(usage, "seven_day");
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(ClaudeQuota {
        status: "ok",
        five_hour,
        seven_day,
        seven_day_opus: window(usage, "seven_day_opus"),
        seven_day_sonnet: window(usage, "seven_day_sonnet"),
        plan,
        observed_at: Some(observed_at),
        message: None,
    })
}

async fn read_limited_json(mut response: reqwest::Response) -> Option<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

fn stale_or(state: &QuotaState, failure: ClaudeQuota) -> ClaudeQuota {
    match &state.last_good {
        Some(good) => ClaudeQuota {
            status: "stale",
            message: failure.message,
            ..good.clone()
        },
        None => failure,
    }
}

fn with_state<T>(update: impl FnOnce(&mut QuotaState) -> T) -> T {
    let mut guard = STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    update(guard.get_or_insert_with(QuotaState::default))
}

/// Returns a cached answer, or takes the remembered credential for a new attempt.
fn begin_attempt(now: Instant) -> Result<Option<Credential>, Box<ClaudeQuota>> {
    with_state(|state| {
        if let (Some(last), Some(result)) = (state.last_attempt, &state.last_result) {
            if now.duration_since(last) < MIN_REFRESH
                || state.backoff_until.is_some_and(|until| now < until)
            {
                return Err(Box::new(result.clone()));
            }
        }
        state.last_attempt = Some(now);
        Ok(state.credential.take())
    })
}

/// Keeps a usable credential for later requests or records why it is unusable.
fn accept_credential(
    credential: Option<Credential>,
) -> Result<(String, Option<String>), Box<ClaudeQuota>> {
    with_state(|state| {
        let Some(credential) = credential else {
            let result = stale_or(
                state,
                ClaudeQuota::failure("signed_out", "Claude Code login not found."),
            );
            state.backoff_until = Some(Instant::now() + FAILURE_BACKOFF);
            state.last_result = Some(result.clone());
            return Err(Box::new(result));
        };
        if credential.is_expired() {
            // Claude Code refreshes its own login; re-read it on the next attempt.
            let result = stale_or(
                state,
                ClaudeQuota::failure(
                    "signed_out",
                    "Claude Code login expired. Open Claude Code to refresh it.",
                ),
            );
            state.last_result = Some(result.clone());
            return Err(Box::new(result));
        }
        let ready = (credential.token.clone(), credential.plan.clone());
        state.credential = Some(credential);
        Ok(ready)
    })
}

fn finish_attempt(outcome: Result<ClaudeQuota, (&'static str, &'static str)>) -> ClaudeQuota {
    with_state(|state| {
        let result = match outcome {
            Ok(quota) => {
                state.last_good = Some(quota.clone());
                state.backoff_until = None;
                quota
            }
            Err((status, message)) => {
                if status == "signed_out" {
                    state.credential = None;
                }
                stale_or(state, ClaudeQuota::failure(status, message))
            }
        };
        state.last_result = Some(result.clone());
        result
    })
}

pub async fn fetch(client: &reqwest::Client) -> ClaudeQuota {
    let credential = match begin_attempt(Instant::now()) {
        Ok(credential) => credential,
        Err(cached) => return *cached,
    };
    // Claude Code may have renewed its login while this process held the old token.
    let credential = match credential.filter(|credential| !credential.is_expired()) {
        Some(value) => Some(value),
        None => load_credential().await,
    };
    let (token, plan) = match accept_credential(credential) {
        Ok(ready) => ready,
        Err(result) => return *result,
    };
    let response = client
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await;
    let observed_at = chrono::Utc::now().to_rfc3339();
    let outcome = match response {
        Ok(response) if response.status().is_success() => match read_limited_json(response).await {
            Some(value) => parse_usage(&value, plan, observed_at)
                .ok_or(("unavailable", "Claude quota response format has changed.")),
            None => Err(("unavailable", "Claude quota response format has changed.")),
        },
        Ok(response) if matches!(response.status().as_u16(), 401 | 403) => Err((
            "signed_out",
            "Claude Code login expired. Open Claude Code to refresh it.",
        )),
        Ok(response) if response.status().as_u16() == 429 => Err((
            "unavailable",
            "Claude quota service is rate limited. It will retry automatically.",
        )),
        Ok(_) => Err((
            "unavailable",
            "Claude quota service is temporarily unavailable.",
        )),
        Err(_) => Err((
            "unavailable",
            "Network unavailable. It will retry automatically.",
        )),
    };
    finish_attempt(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keychain_and_file_credentials_without_exposing_other_fields() {
        let credential = parse_credential(r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1800000000000,"subscriptionType":"max"}}"#).unwrap();
        assert_eq!(credential.token, "tok");
        assert_eq!(credential.expires_at_ms, Some(1_800_000_000_000));
        assert_eq!(credential.plan.as_deref(), Some("max"));
        assert!(parse_credential(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
        assert!(parse_credential("not json").is_none());
    }

    #[test]
    fn parses_usage_windows_and_rejects_unknown_shapes() {
        let usage = serde_json::json!({
            "five_hour": {"utilization": 41.0, "resets_at": "2026-11-10T15:00:00.123+00:00"},
            "seven_day": {"utilization": "63.5", "resets_at": "2026-11-14T08:00:00Z"},
            "seven_day_opus": {"utilization": 120, "resets_at": null},
            "seven_day_oauth_apps": null
        });
        let quota = parse_usage(&usage, Some("max".into()), "now".into()).unwrap();
        assert_eq!(quota.five_hour.as_ref().unwrap().used_percent, 41.0);
        assert_eq!(
            quota.five_hour.as_ref().unwrap().resets_at.as_deref(),
            Some("2026-11-10T15:00:00.123+00:00")
        );
        assert_eq!(quota.seven_day.as_ref().unwrap().used_percent, 63.5);
        assert_eq!(quota.seven_day_opus.as_ref().unwrap().used_percent, 100.0);
        assert_eq!(quota.seven_day_opus.as_ref().unwrap().resets_at, None);
        assert!(quota.seven_day_sonnet.is_none());
        assert!(
            parse_usage(&serde_json::json!({"unexpected": true}), None, "now".into()).is_none()
        );
    }
}

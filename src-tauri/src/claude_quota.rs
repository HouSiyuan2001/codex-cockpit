//! Read-only Claude subscription limits (5-hour and weekly), the same figures
//! Claude Code's `/usage` shows.
//!
//! The Claude Code OAuth login is read from the macOS Keychain item
//! `Claude Code-credentials`, or from `<config>/.credentials.json` on Windows
//! and Linux. Cockpit keeps the access token in memory. Claude Code handles
//! renewal in its own credential store.
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MIN_REFRESH: Duration = Duration::from_secs(55);
const MIN_MANUAL_REFRESH: Duration = Duration::from_secs(10);
const FAILURE_BACKOFF: Duration = Duration::from_secs(15 * 60);
const RENEWAL_TIMEOUT: Duration = Duration::from_secs(45);
/// Set while a Claude Code renewal child is alive, so two never overlap.
static RENEWAL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
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
    has_refresh_token: bool,
    config_directory: Option<PathBuf>,
}

impl Credential {
    fn is_expired(&self) -> bool {
        self.expires_at_ms
            .is_some_and(|expires| expires <= Utc::now().timestamp_millis())
    }
}

#[derive(Default)]
struct QuotaState {
    credential: Option<Credential>,
    last_good: Option<ClaudeQuota>,
    last_attempt: Option<(Instant, DateTime<Utc>)>,
    last_result: Option<ClaudeQuota>,
    backoff_until: Option<Instant>,
    last_renewal_attempt: Option<Instant>,
}

static STATE: Mutex<Option<QuotaState>> = Mutex::const_new(None);

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
        has_refresh_token: oauth
            .get("refreshToken")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.trim().is_empty()),
        config_directory: None,
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
        Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
            .kill_on_drop(true)
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
    credential_files().into_iter().find_map(|path| {
        let mut credential = parse_credential(&std::fs::read_to_string(&path).ok()?)?;
        credential.config_directory = path.parent().map(Path::to_path_buf);
        Some(credential)
    })
}

fn claude_program() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join(name)),
        );
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(name));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
        candidates.push(PathBuf::from("/usr/local/bin/claude"));
    }
    #[cfg(windows)]
    if let Some(local_data) = dirs::data_local_dir() {
        candidates.push(local_data.join("Microsoft/WinGet/Links").join(name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

async fn renew_with_claude_code(config_directory: Option<&Path>) -> Option<Credential> {
    let mut command = Command::new(claude_program()?);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    // Initialization checks the subscription login without starting a chat.
    // The child uses the credential store that supplied the expired login.
    command
        .args([
            "--safe-mode",
            "--setting-sources",
            "",
            "--no-chrome",
            "--strict-mcp-config",
            "--tools",
            "",
            "--init-only",
        ])
        .current_dir(std::env::temp_dir())
        .env("DISABLE_AUTOUPDATER", "1")
        .env_remove("CLAUDE_CONFIG_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Never kill a renewal: Claude Code rotates the refresh token, and a
        // child stopped between the server's answer and the Keychain write
        // leaves a spent token behind, which signs the user out next time.
        .kill_on_drop(false);
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_PROFILE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        command.env_remove(key);
    }
    let default_directory =
        dirs::home_dir().and_then(|home| home.join(".claude").canonicalize().ok());
    if let Some(directory) =
        config_directory.filter(|directory| Some(*directory) != default_directory.as_deref())
    {
        command.env("CLAUDE_CONFIG_DIR", directory);
    }
    use std::sync::atomic::Ordering;
    if RENEWAL_RUNNING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let Ok(mut child) = command.spawn() else {
        RENEWAL_RUNNING.store(false, Ordering::SeqCst);
        return None;
    };
    if tokio::time::timeout(RENEWAL_TIMEOUT, child.wait())
        .await
        .is_ok()
    {
        RENEWAL_RUNNING.store(false, Ordering::SeqCst);
    } else {
        // Slow network or machine: let it finish on its own and reap it later.
        tokio::spawn(async move {
            let _ = child.wait().await;
            RENEWAL_RUNNING.store(false, Ordering::SeqCst);
        });
        return None;
    }
    load_credential()
        .await
        .filter(|credential| !credential.is_expired())
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

impl QuotaState {
    fn begin_renewal(&mut self, credential: &Credential, now: Instant) -> bool {
        if !credential.has_refresh_token
            || !credential.is_expired()
            || self
                .last_renewal_attempt
                .is_some_and(|last| now.duration_since(last) < FAILURE_BACKOFF)
        {
            return false;
        }
        self.last_renewal_attempt = Some(now);
        true
    }

    fn cached_result(
        &self,
        now: Instant,
        wall_time: DateTime<Utc>,
        manual: bool,
    ) -> Option<ClaudeQuota> {
        let (last_attempt, last_wall_time) = self.last_attempt?;
        let result = self.last_result.as_ref()?;
        let elapsed = now.duration_since(last_attempt);
        let manual_ready = manual && elapsed >= MIN_MANUAL_REFRESH;
        if self.backoff_until.is_some_and(|until| now < until)
            && !(manual_ready && result.status == "signed_out")
        {
            return Some(result.clone());
        }
        let crossed_reset = result
            .five_hour
            .as_ref()
            .and_then(|window| DateTime::parse_from_rfc3339(window.resets_at.as_deref()?).ok())
            .is_some_and(|reset| last_wall_time < reset && wall_time >= reset);
        (elapsed < MIN_REFRESH && !manual_ready && !crossed_reset).then(|| result.clone())
    }

    fn finish_attempt(
        &mut self,
        outcome: Result<ClaudeQuota, (&'static str, &'static str)>,
    ) -> ClaudeQuota {
        let result = match outcome {
            Ok(quota) => {
                self.last_good = Some(quota.clone());
                self.backoff_until = None;
                quota
            }
            Err(("signed_out", message)) => {
                self.credential = None;
                self.last_good = None;
                ClaudeQuota::failure("signed_out", message)
            }
            Err((status, message)) => match &self.last_good {
                Some(good) => ClaudeQuota {
                    status: "stale",
                    message: Some(message),
                    ..good.clone()
                },
                None => ClaudeQuota::failure(status, message),
            },
        };
        self.last_result = Some(result.clone());
        result
    }
}

pub async fn fetch(client: &reqwest::Client, manual: bool) -> ClaudeQuota {
    // All windows share a single read, including when a poll and the reset timer coincide.
    let mut guard = STATE.lock().await;
    let state = guard.get_or_insert_with(QuotaState::default);
    let now = Instant::now();
    let wall_time = Utc::now();
    if let Some(cached) = state.cached_result(now, wall_time, manual) {
        return cached;
    }
    state.last_attempt = Some((now, wall_time));
    // Claude Code may have renewed its login while this process held the old token.
    let credential = match state
        .credential
        .take()
        .filter(|credential| !manual && !credential.is_expired())
    {
        Some(value) => Some(value),
        None => load_credential().await,
    };
    let Some(mut credential) = credential else {
        state.backoff_until = Some(Instant::now() + FAILURE_BACKOFF);
        return state.finish_attempt(Err(("signed_out", "Claude Code login not found.")));
    };
    let expired = (
        "signed_out",
        "Claude Code login expired. Open Claude Code to refresh it.",
    );
    if state.begin_renewal(&credential, Instant::now()) {
        if let Some(renewed) = renew_with_claude_code(credential.config_directory.as_deref()).await
        {
            credential = renewed;
        }
    }
    if credential.is_expired() {
        state.backoff_until = None;
        return state.finish_attempt(Err(expired));
    }
    let response = client
        .get(USAGE_URL)
        .bearer_auth(&credential.token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await;
    let observed_at = Utc::now().to_rfc3339();
    let plan = credential.plan.clone();
    state.credential = Some(credential);
    state.backoff_until = None;
    let outcome = match response {
        Ok(response) if response.status().is_success() => match read_limited_json(response).await {
            Some(value) => parse_usage(&value, plan, observed_at)
                .ok_or(("unavailable", "Claude quota response format has changed.")),
            None => Err(("unavailable", "Claude quota response format has changed.")),
        },
        Ok(response) if matches!(response.status().as_u16(), 401 | 403) => Err(expired),
        Ok(response) if response.status().as_u16() == 429 => {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map_or(MIN_REFRESH, |seconds| {
                    Duration::from_secs(seconds).max(MIN_REFRESH)
                });
            state.backoff_until = Instant::now().checked_add(retry_after);
            Err((
                "unavailable",
                "Claude quota service is rate limited. It will retry automatically.",
            ))
        }
        Ok(_) => Err((
            "unavailable",
            "Claude quota service is temporarily unavailable.",
        )),
        Err(_) => Err((
            "unavailable",
            "Network unavailable. It will retry automatically.",
        )),
    };
    state.finish_attempt(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_at_the_five_hour_boundary_and_honors_service_backoff() {
        let started = Instant::now();
        let observed = "2026-11-11T13:59:55Z".parse::<DateTime<Utc>>().unwrap();
        let reset = "2026-11-11T14:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let quota = parse_usage(
            &serde_json::json!({"five_hour": {"utilization": 85, "resets_at": reset}}),
            None,
            observed.to_rfc3339(),
        )
        .unwrap();
        let mut state = QuotaState {
            last_attempt: Some((started, observed)),
            last_result: Some(quota),
            ..QuotaState::default()
        };
        assert!(state.cached_result(started, observed, false).is_some());
        let next = started + Duration::from_secs(5);
        assert!(state.cached_result(next, reset, false).is_none());
        state.last_attempt = Some((next, reset));
        assert!(state.cached_result(next, reset, false).is_some());

        state.backoff_until = Some(started + Duration::from_secs(120));
        let retry = started + MIN_REFRESH;
        assert!(state.cached_result(retry, reset, true).is_some());
    }

    #[test]
    fn expired_login_clears_the_old_snapshot_and_manual_refresh_can_check_a_new_login() {
        let started = Instant::now();
        let observed = "2026-11-11T14:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let quota = parse_usage(
            &serde_json::json!({"five_hour": {"utilization": 85}}),
            None,
            observed.to_rfc3339(),
        )
        .unwrap();
        let mut state = QuotaState {
            last_attempt: Some((started, observed)),
            last_good: Some(quota),
            backoff_until: Some(started + FAILURE_BACKOFF),
            ..QuotaState::default()
        };
        let result = state.finish_attempt(Err(("signed_out", "Claude Code login expired.")));
        assert_eq!(result.status, "signed_out");
        assert!(result.five_hour.is_none());
        assert!(state.last_good.is_none());
        let retry = started + MIN_MANUAL_REFRESH;
        assert!(state.cached_result(retry, observed, false).is_some());
        assert!(state.cached_result(retry, observed, true).is_none());
    }

    #[test]
    fn parses_keychain_and_file_credentials_without_exposing_other_fields() {
        let credential = parse_credential(r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1800000000000,"subscriptionType":"max"}}"#).unwrap();
        assert_eq!(credential.token, "tok");
        assert_eq!(credential.expires_at_ms, Some(1_800_000_000_000));
        assert_eq!(credential.plan.as_deref(), Some("max"));
        assert!(credential.has_refresh_token);
        assert!(parse_credential(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
        assert!(parse_credential("not json").is_none());
    }

    #[test]
    fn renews_only_expired_logins_with_a_refresh_token_and_limits_retries() {
        let started = Instant::now();
        let mut state = QuotaState::default();
        let mut credential = parse_credential(
            r#"{"claudeAiOauth":{"accessToken":"tok","refreshToken":"r","expiresAt":1}}"#,
        )
        .unwrap();
        credential.expires_at_ms = Some(i64::MAX);
        assert!(!state.begin_renewal(&credential, started));
        credential.expires_at_ms = Some(1);
        credential.has_refresh_token = false;
        assert!(!state.begin_renewal(&credential, started));
        credential.has_refresh_token = true;
        assert!(state.begin_renewal(&credential, started));
        assert!(!state.begin_renewal(&credential, started + MIN_REFRESH));
        assert!(state.begin_renewal(&credential, started + FAILURE_BACKOFF));
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

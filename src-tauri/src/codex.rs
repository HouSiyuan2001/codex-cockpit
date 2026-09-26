use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, TimeZone, Timelike, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader},
    process::{ChildStdin, Command},
    time::timeout,
};

use crate::models::{ProviderSnapshot, RateLimitSnapshot, UsageWindow};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_AUTH_BYTES: u64 = 256 * 1024;
const WEEKLY_WINDOW_MINUTES: u64 = 10_080;
const COMPLETE_DAY_GRACE_SECONDS: i64 = 15 * 60;
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(6);
const USAGE_DAY_START_HOUR: u32 = 4;
const BEIJING_OFFSET_SECONDS: i32 = 8 * 60 * 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyQuotaUsage {
    pub local_date: String,
    pub observed_used_percent: f64,
    pub sample_count: usize,
    pub first_observed_at: Option<String>,
    pub last_observed_at: Option<String>,
    pub coverage: String,
    pub source: &'static str,
}

#[derive(Debug, Clone)]
struct QuotaObservation {
    observed_at: DateTime<FixedOffset>,
    used_percent: f64,
    resets_at: i64,
    window_minutes: u64,
}

struct Auth {
    access_token: String,
    account_id: Option<String>,
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

fn auth_path() -> Option<PathBuf> {
    codex_home().map(|home| home.join("auth.json"))
}

fn pick_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| value.get(*key)?.as_str())
}

fn account_id_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    pick_string(
        &value,
        &[
            "https://api.openai.com/auth.chatgpt_account_id",
            "chatgpt_account_id",
        ],
    )
    .map(str::to_owned)
}

fn load_auth() -> Result<Auth, &'static str> {
    let path = auth_path().ok_or("Codex login was not found.")?;
    let metadata = fs::metadata(&path).map_err(|_| "Please sign in to Codex Desktop first.")?;
    if !metadata.is_file() || metadata.len() > MAX_AUTH_BYTES {
        return Err("Codex login data is unavailable.");
    }
    let raw = fs::read_to_string(path).map_err(|_| "Please sign in to Codex Desktop first.")?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "Codex login format has changed.")?;
    let tokens = value.get("tokens").unwrap_or(&value);
    let access_token = pick_string(tokens, &["access_token", "accessToken"])
        .ok_or("Codex login expired. Please sign in again.")?
        .to_owned();
    let account_id = pick_string(tokens, &["account_id", "accountId"])
        .map(str::to_owned)
        .or_else(|| account_id_from_jwt(&access_token));
    Ok(Auth {
        access_token,
        account_id,
    })
}

fn headers(auth: &Auth) -> Result<HeaderMap, &'static str> {
    let mut result = HeaderMap::new();
    let mut bearer = HeaderValue::from_str(&format!("Bearer {}", auth.access_token))
        .map_err(|_| "Codex login data is invalid.")?;
    bearer.set_sensitive(true);
    result.insert(AUTHORIZATION, bearer);
    result.insert(ACCEPT, HeaderValue::from_static("application/json"));
    result.insert("originator", HeaderValue::from_static("Codex Desktop"));
    result.insert("OAI-Product-Sku", HeaderValue::from_static("CODEX"));
    if let Some(account_id) = &auth.account_id {
        let mut value =
            HeaderValue::from_str(account_id).map_err(|_| "Account identifier is invalid.")?;
        value.set_sensitive(true);
        result.insert("ChatGPT-Account-Id", value);
    }
    Ok(result)
}

fn number_with_key<'a>(value: &'a Value, keys: &[&'a str]) -> Option<(&'a str, f64)> {
    keys.iter()
        .find_map(|key| value.get(*key)?.as_f64().map(|number| (*key, number)))
}

fn integer(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))
    })
}

fn timestamp(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let item = value.get(*key)?;
        if let Some(text) = item.as_str() {
            return Some(text.to_owned());
        }
        item.as_i64()
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
            .map(|time| time.to_rfc3339())
    })
}

fn timestamp_seconds(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let item = value.get(*key)?;
        item.as_i64()
            .or_else(|| item.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| {
                item.as_str()
                    .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
                    .map(|time| time.timestamp())
            })
    })
}

fn parse_weekly_observation(line: &str) -> Option<QuotaObservation> {
    if !line.contains("\"token_count\"") || !line.contains("\"rate_limits\"") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let rate_limits = payload.get("rate_limits")?;
    if rate_limits
        .get("limit_id")
        .and_then(Value::as_str)
        .is_some_and(|limit| !limit.eq_ignore_ascii_case("codex"))
    {
        return None;
    }
    let window = ["primary", "secondary"]
        .iter()
        .filter_map(|key| rate_limits.get(*key))
        .find(|window| {
            integer(window, &["window_minutes", "windowMinutes"]) == Some(WEEKLY_WINDOW_MINUTES)
        })?;
    let used_percent = number_with_key(window, &["used_percent", "usedPercent"])?.1;
    if !used_percent.is_finite() {
        return None;
    }
    let resets_at = timestamp_seconds(window, &["resets_at", "resetsAt"])?;
    let window_minutes = integer(window, &["window_minutes", "windowMinutes"])?;
    Some(QuotaObservation {
        observed_at: DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?).ok()?,
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at,
        window_minutes,
    })
}

fn usage_date_for_local_time(local_date: NaiveDate, hour: u32) -> NaiveDate {
    if hour < USAGE_DAY_START_HOUR {
        local_date.pred_opt().unwrap_or(local_date)
    } else {
        local_date
    }
}

fn beijing_offset() -> FixedOffset {
    FixedOffset::east_opt(BEIJING_OFFSET_SECONDS).expect("Beijing offset is valid")
}

fn beijing_now() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&beijing_offset())
}

fn usage_day_start(local_date: NaiveDate) -> Option<DateTime<FixedOffset>> {
    beijing_offset()
        .from_local_datetime(&local_date.and_hms_opt(USAGE_DAY_START_HOUR, 0, 0)?)
        .single()
}

fn usage_day_end(local_date: NaiveDate) -> Option<DateTime<FixedOffset>> {
    usage_day_start(local_date.succ_opt()?)
}

fn session_dates_for_usage_day(local_date: NaiveDate) -> impl Iterator<Item = NaiveDate> {
    [Some(local_date), local_date.succ_opt()]
        .into_iter()
        .flatten()
}

fn read_observations(
    path: &Path,
    day_start_timestamp: i64,
    end_timestamp: i64,
    output: &mut Vec<QuotaObservation>,
) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Some(observation) = parse_weekly_observation(&line) else {
            continue;
        };
        let observed_timestamp = observation.observed_at.timestamp();
        if observed_timestamp >= day_start_timestamp && observed_timestamp <= end_timestamp {
            output.push(observation);
        }
    }
}

fn summarize_daily_usage(
    local_date: NaiveDate,
    day_start_timestamp: i64,
    mut observations: Vec<QuotaObservation>,
) -> DailyQuotaUsage {
    observations.sort_by_key(|item| item.observed_at.timestamp_millis());
    let first_observed_at = observations
        .first()
        .map(|item| item.observed_at.to_rfc3339());
    let last_observed_at = observations
        .last()
        .map(|item| item.observed_at.to_rfc3339());
    let sample_count = observations.len();
    if observations.is_empty() {
        return DailyQuotaUsage {
            local_date: local_date.to_string(),
            observed_used_percent: 0.0,
            sample_count: 0,
            first_observed_at: None,
            last_observed_at: None,
            coverage: "unavailable".into(),
            source: "codex-session-rate-limits",
        };
    }

    let mut cycles: BTreeMap<(i64, u64), (f64, f64, i64)> = BTreeMap::new();
    for item in &observations {
        let cycle_key = (item.resets_at.div_euclid(60), item.window_minutes);
        let cycle_start = item
            .resets_at
            .saturating_sub((item.window_minutes as i64).saturating_mul(60));
        cycles
            .entry(cycle_key)
            .and_modify(|summary| {
                summary.0 = summary.0.min(item.used_percent);
                summary.1 = summary.1.max(item.used_percent);
                summary.2 = summary.2.min(cycle_start);
            })
            .or_insert((item.used_percent, item.used_percent, cycle_start));
    }
    let observed_used_percent = cycles
        .values()
        .map(|(minimum, maximum, cycle_start)| {
            if *cycle_start >= day_start_timestamp {
                *maximum
            } else {
                (*maximum - *minimum).max(0.0)
            }
        })
        .sum::<f64>();
    let observed_used_percent = (observed_used_percent.clamp(0.0, 10_000.0) * 10.0).round() / 10.0;
    let first_timestamp = observations
        .first()
        .map(|item| item.observed_at.timestamp())
        .unwrap_or(i64::MAX);
    let coverage = if first_timestamp <= day_start_timestamp + COMPLETE_DAY_GRACE_SECONDS {
        "complete"
    } else {
        "partial"
    };

    DailyQuotaUsage {
        local_date: local_date.to_string(),
        observed_used_percent,
        sample_count,
        first_observed_at,
        last_observed_at,
        coverage: coverage.into(),
        source: "codex-session-rate-limits",
    }
}

fn read_usage_for_date(local_date: NaiveDate, latest_timestamp: i64) -> DailyQuotaUsage {
    let Some(day_start) = usage_day_start(local_date) else {
        return summarize_daily_usage(local_date, latest_timestamp, Vec::new());
    };
    let end_timestamp = usage_day_end(local_date)
        .map(|day_end| latest_timestamp.min(day_end.timestamp()))
        .unwrap_or(latest_timestamp);
    if end_timestamp < day_start.timestamp() {
        return summarize_daily_usage(local_date, day_start.timestamp(), Vec::new());
    }
    let Some(root) = codex_home().map(|home| home.join("sessions")) else {
        return summarize_daily_usage(local_date, day_start.timestamp(), Vec::new());
    };
    let mut observations = Vec::new();
    for date in session_dates_for_usage_day(local_date) {
        let directory = root
            .join(format!("{:04}", date.year()))
            .join(format!("{:02}", date.month()))
            .join(format!("{:02}", date.day()));
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                read_observations(
                    &path,
                    day_start.timestamp(),
                    end_timestamp,
                    &mut observations,
                );
            }
        }
    }
    summarize_daily_usage(local_date, day_start.timestamp(), observations)
}

pub fn read_today_usage() -> DailyQuotaUsage {
    let now = beijing_now();
    let local_date = usage_date_for_local_time(now.date_naive(), now.hour());
    read_usage_for_date(local_date, now.timestamp())
}

pub fn read_usage_history(days: usize) -> Vec<DailyQuotaUsage> {
    let count = days.clamp(1, 120);
    let now = beijing_now();
    let mut local_date = usage_date_for_local_time(now.date_naive(), now.hour());
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let latest_timestamp = if index == 0 {
            now.timestamp()
        } else {
            usage_day_end(local_date)
                .map(|day_end| day_end.timestamp())
                .unwrap_or(now.timestamp())
        };
        result.push(read_usage_for_date(local_date, latest_timestamp));
        let Some(previous_date) = local_date.pred_opt() else {
            break;
        };
        local_date = previous_date;
    }
    result
}

fn collect_reset_credit_expirations(value: &Value) -> Vec<String> {
    fn visit(value: &Value, output: &mut Vec<String>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(item, output);
                }
            }
            Value::Object(map) => {
                if let Some(time) = timestamp(
                    value,
                    &[
                        "expires_at",
                        "expiresAt",
                        "expiration_time",
                        "expirationTime",
                        "expires",
                    ],
                ) {
                    output.push(time);
                }
                for key in [
                    "credits",
                    "reset_credits",
                    "resetCredits",
                    "available",
                    "items",
                    "grants",
                ] {
                    if let Some(child) = map.get(key) {
                        visit(child, output);
                    }
                }
            }
            _ => {}
        }
    }

    let mut expirations = Vec::new();
    visit(value, &mut expirations);
    expirations.sort();
    expirations.dedup();
    expirations
}

fn scale_ratio_field(key: &str, value: f64) -> bool {
    matches!(
        key,
        "remaining_ratio" | "remainingRatio" | "used_ratio" | "usedRatio" | "utilization"
    ) || (!key.contains("percent") && !key.contains("pct") && value <= 1.0)
}

fn parse_window(value: Option<&Value>) -> Option<UsageWindow> {
    let value = value?;
    let remaining_percent = if let Some((key, remaining)) = number_with_key(
        value,
        &[
            "remaining_percent",
            "remainingPercent",
            "remaining_pct",
            "remainingPct",
            "remaining_ratio",
            "remainingRatio",
            "remaining",
        ],
    ) {
        if scale_ratio_field(key, remaining) {
            remaining * 100.0
        } else {
            remaining
        }
    } else {
        let (key, used) = number_with_key(
            value,
            &[
                "used_percent",
                "usedPercent",
                "used_pct",
                "usedPct",
                "used_ratio",
                "usedRatio",
                "utilization",
                "used",
            ],
        )?;
        let used_percent = if scale_ratio_field(key, used) {
            used * 100.0
        } else {
            used
        };
        100.0 - used_percent
    };
    Some(UsageWindow {
        remaining_percent: remaining_percent.clamp(0.0, 100.0),
        resets_at: timestamp(
            value,
            &[
                "reset_at",
                "resetAt",
                "resets_at",
                "resetsAt",
                "reset_time",
                "resetTime",
            ],
        ),
        window_seconds: integer(
            value,
            &[
                "limit_window_seconds",
                "limitWindowSeconds",
                "window_seconds",
                "windowSeconds",
                "duration_seconds",
                "durationSeconds",
                "period_seconds",
                "periodSeconds",
            ],
        )
        .unwrap_or(0),
    })
}

fn find_window<'a>(
    rate_limit: &'a Value,
    names: &[&str],
    expected_seconds: u64,
) -> Option<&'a Value> {
    for name in names {
        if let Some(value) = rate_limit.get(*name) {
            let Some(window) = parse_window(Some(value)) else {
                continue;
            };
            if window.window_seconds == 0
                || (expected_seconds > 0 && window.window_seconds.abs_diff(expected_seconds) <= 60)
            {
                return Some(value);
            }
        }
    }

    if expected_seconds > 0 {
        if let Some(values) = rate_limit.as_object() {
            for value in values.values() {
                let Some(window) = parse_window(Some(value)) else {
                    continue;
                };
                if window.window_seconds.abs_diff(expected_seconds) <= 60 {
                    return Some(value);
                }
            }

            let mut parseable = values
                .values()
                .filter(|value| parse_window(Some(value)).is_some());
            let only = parseable.next();
            if only.is_some() && parseable.next().is_none() {
                return only;
            }
        }
    }

    for key in [
        "windows",
        "limit_windows",
        "limitWindows",
        "limits",
        "buckets",
    ] {
        let Some(items) = rate_limit.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let Some(window) = parse_window(Some(item)) else {
                continue;
            };
            let matches_duration =
                expected_seconds > 0 && window.window_seconds.abs_diff(expected_seconds) <= 60;
            let matches_name = pick_string(item, &["name", "type", "id", "window", "label"])
                .map(|text| {
                    let lower = text.to_ascii_lowercase();
                    names.iter().any(|name| {
                        lower == name.to_ascii_lowercase()
                            || lower.contains(&name.to_ascii_lowercase())
                    })
                })
                .unwrap_or(false);
            if matches_duration || matches_name {
                return Some(item);
            }
        }
    }

    None
}

fn codex_program() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("CODEX_BIN") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        let directories: Vec<_> = std::env::split_paths(&path).collect();
        for directory in &directories {
            #[cfg(windows)]
            candidates.push(directory.join("codex.exe"));
            #[cfg(not(windows))]
            candidates.push(directory.join("codex"));
        }
        #[cfg(windows)]
        for directory in &directories {
            candidates.push(directory.join("codex.cmd"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(windows))]
        candidates.push(home.join(".local/bin/codex"));
        #[cfg(windows)]
        candidates.push(home.join("AppData/Roaming/npm/codex.cmd"));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
        candidates.push(PathBuf::from("/usr/local/bin/codex"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

async fn write_app_server_request(stdin: &mut ChildStdin, value: Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(&value)
        .map_err(|_| "Codex App Server request could not be encoded.".to_string())?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|_| "Codex App Server did not accept the request.".to_string())
}

async fn read_app_server_rate_limits() -> Result<(Value, String), String> {
    let program = codex_program().ok_or_else(|| "Codex App Server was not found.".to_string())?;
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Codex App Server could not be started.".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex App Server stdin is unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex App Server stdout is unavailable.".to_string())?;

    let requests = [
        serde_json::json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "quota-float", "version": env!("CARGO_PKG_VERSION")}}
        }),
        serde_json::json!({"method": "initialized"}),
        serde_json::json!({"id": 2, "method": "account/rateLimits/read", "params": null}),
    ];
    for request in requests {
        if let Err(error) = write_app_server_request(&mut stdin, request).await {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    }
    stdin
        .flush()
        .await
        .map_err(|_| "Codex App Server did not flush the request.".to_string())?;

    let mut lines = AsyncBufReader::new(stdout).lines();
    let response = timeout(APP_SERVER_TIMEOUT, async {
        loop {
            let line = lines
                .next_line()
                .await
                .map_err(|_| "Codex App Server output could not be read.".to_string())?
                .ok_or_else(|| {
                    "Codex App Server stopped before returning quota data.".to_string()
                })?;
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            if value.get("error").is_some() {
                return Err("Codex App Server rejected the quota read.".to_string());
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex App Server returned no quota result.".to_string());
        }
    })
    .await
    .map_err(|_| "Codex App Server quota read timed out.".to_string())?;
    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok((response?, chrono::Utc::now().to_rfc3339()))
}

fn parse_app_server_window(value: &Value) -> Option<UsageWindow> {
    let used_percent = number_with_key(value, &["usedPercent", "used_percent"])?.1;
    if !used_percent.is_finite() {
        return None;
    }
    Some(UsageWindow {
        remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
        resets_at: timestamp(value, &["resetsAt", "resets_at"]),
        window_seconds: integer(value, &["windowDurationMins", "window_duration_mins"])
            .unwrap_or_default()
            .saturating_mul(60),
    })
}

fn find_app_server_bucket(result: &Value) -> Option<&Value> {
    result
        .get("rateLimitsByLimitId")
        .and_then(|value| value.get("codex"))
        .or_else(|| result.get("rateLimits"))
}

fn find_app_server_window(bucket: &Value, expected_minutes: u64) -> Option<&Value> {
    let windows = ["primary", "secondary"]
        .iter()
        .filter_map(|key| bucket.get(*key));
    if let Some(window) = windows.clone().find(|value| {
        integer(value, &["windowDurationMins", "window_duration_mins"])
            .is_some_and(|minutes| minutes.abs_diff(expected_minutes) <= 1)
    }) {
        return Some(window);
    }

    // The installed App Server currently reports duration metadata. Keep the
    // legacy single-window fallback only when it is genuinely unambiguous;
    // otherwise a five-hour primary window must not be mislabeled as weekly.
    if expected_minutes == WEEKLY_WINDOW_MINUTES {
        let mut usable = windows.filter(|value| {
            number_with_key(value, &["usedPercent", "used_percent"]).is_some()
                && integer(value, &["windowDurationMins", "window_duration_mins"]).is_none()
        });
        let first = usable.next();
        if first.is_some() && usable.next().is_none() {
            return first;
        }
    }
    None
}

fn parse_app_server_snapshot(
    result: &Value,
    observed_at: String,
) -> Result<ProviderSnapshot, String> {
    let bucket = find_app_server_bucket(result)
        .ok_or_else(|| "Codex App Server response has no Codex quota bucket.".to_string())?;
    let weekly_value = find_app_server_window(bucket, WEEKLY_WINDOW_MINUTES)
        .ok_or_else(|| "Codex App Server response has no usable quota window.".to_string())?;
    let weekly_window = parse_app_server_window(weekly_value)
        .ok_or_else(|| "Codex App Server weekly quota window is incomplete.".to_string())?;
    let used_percent = number_with_key(weekly_value, &["usedPercent", "used_percent"])
        .map(|(_, value)| value.clamp(0.0, 100.0))
        .ok_or_else(|| "Codex App Server weekly usage is missing.".to_string())?;
    let short_window = ["primary", "secondary"]
        .iter()
        .filter_map(|key| bucket.get(*key))
        .find(|value| {
            integer(value, &["windowDurationMins", "window_duration_mins"])
                .is_some_and(|minutes| minutes.abs_diff(300) <= 1)
        })
        .and_then(parse_app_server_window);
    let reset_credits = result
        .get("rateLimitResetCredits")
        .and_then(|value| integer(value, &["availableCount", "available_count"]));
    let plan = bucket
        .get("planType")
        .and_then(Value::as_str)
        .map(|value| value.to_uppercase());
    let rate_limit_snapshot = RateLimitSnapshot {
        source: "app-server".into(),
        used_percent,
        window_duration_mins: integer(
            weekly_value,
            &["windowDurationMins", "window_duration_mins"],
        ),
        resets_at: timestamp(weekly_value, &["resetsAt", "resets_at"]),
        observed_at: observed_at.clone(),
    };
    Ok(ProviderSnapshot {
        provider: "codex".into(),
        display_name: "CODEX".into(),
        plan,
        short_window,
        weekly_window: Some(weekly_window),
        monthly_window: None,
        reset_credits,
        reset_credit_expires_at: Vec::new(),
        balance_remaining: None,
        balance_unit: None,
        rate_limit_snapshot: Some(rate_limit_snapshot),
        updated_at: observed_at,
        status: "ok".into(),
        message: None,
    })
}

async fn fetch_app_server_snapshot() -> Result<ProviderSnapshot, String> {
    let (result, observed_at) = read_app_server_rate_limits().await?;
    parse_app_server_snapshot(&result, observed_at)
}

fn safe_http_failure(status: reqwest::StatusCode) -> (&'static str, &'static str) {
    match status.as_u16() {
        401 | 403 => ("signed_out", "Codex login expired. Please sign in again."),
        429 => (
            "unavailable",
            "Quota service is rate limited. It will retry automatically.",
        ),
        _ => ("unavailable", "Quota service is temporarily unavailable."),
    }
}

async fn limited_json(mut response: reqwest::Response) -> Result<Value, ()> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len().saturating_add(chunk.len()) as u64 > MAX_RESPONSE_BYTES {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

pub async fn fetch_snapshot(client: &reqwest::Client) -> ProviderSnapshot {
    if let Ok(snapshot) = fetch_app_server_snapshot().await {
        return snapshot;
    }
    fetch_legacy_snapshot(client).await
}

async fn fetch_legacy_snapshot(client: &reqwest::Client) -> ProviderSnapshot {
    let auth = match load_auth() {
        Ok(value) => value,
        Err(message) => return ProviderSnapshot::failure("signed_out", message),
    };
    let request_headers = match headers(&auth) {
        Ok(value) => value,
        Err(message) => return ProviderSnapshot::failure("signed_out", message),
    };

    let (usage_result, credits_result) = tokio::join!(
        client
            .get(USAGE_URL)
            .headers(request_headers.clone())
            .send(),
        client.get(CREDITS_URL).headers(request_headers).send(),
    );

    let usage_response = match usage_result {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            let (status, message) = safe_http_failure(response.status());
            return ProviderSnapshot::failure(status, message);
        }
        Err(_) => {
            return ProviderSnapshot::failure(
                "unavailable",
                "Network unavailable. It will retry automatically.",
            )
        }
    };
    let usage: Value = match limited_json(usage_response).await {
        Ok(value) => value,
        Err(_) => {
            return ProviderSnapshot::failure("unavailable", "Quota response format has changed.")
        }
    };
    let rate_limit = usage
        .get("rate_limit")
        .or_else(|| usage.get("rateLimit"))
        .unwrap_or(&usage);
    // Keep collecting the legacy five-hour window for compatibility and diagnostics.
    // The UI deliberately ignores this field and presents weekly quota only.
    let short_window = parse_window(find_window(
        rate_limit,
        &[
            "primary_window",
            "primaryWindow",
            "short_window",
            "shortWindow",
            "five_hour_window",
            "fiveHourWindow",
            "5h",
            "primary",
        ],
        18_000,
    ));
    let weekly_window = parse_window(find_window(
        rate_limit,
        &[
            "secondary_window",
            "secondaryWindow",
            "weekly_window",
            "weeklyWindow",
            "week_window",
            "weekWindow",
            "weekly",
            "secondary",
            "primary_window",
            "primaryWindow",
            "primary",
        ],
        604_800,
    ));
    if weekly_window.is_none() {
        return ProviderSnapshot::failure(
            "unavailable",
            "Quota response is missing the weekly window.",
        );
    }

    let usage_credits = usage
        .get("rate_limit_reset_credits")
        .or_else(|| usage.get("rateLimitResetCredits"));
    let usage_reset_credits = usage_credits.and_then(|value| {
        integer(
            value,
            &[
                "available_count",
                "availableCount",
                "remaining",
                "count",
                "quantity",
            ],
        )
    });
    let usage_reset_credit_expires_at = usage_credits
        .map(collect_reset_credit_expirations)
        .unwrap_or_default();

    let (reset_credits, reset_credit_expires_at) = match credits_result {
        Ok(response) if response.status().is_success() => match limited_json(response).await.ok() {
            Some(value) => (
                integer(
                    &value,
                    &[
                        "available_count",
                        "availableCount",
                        "remaining",
                        "count",
                        "quantity",
                    ],
                )
                .or(usage_reset_credits),
                {
                    let expirations = collect_reset_credit_expirations(&value);
                    if expirations.is_empty() {
                        usage_reset_credit_expires_at
                    } else {
                        expirations
                    }
                },
            ),
            None => (usage_reset_credits, usage_reset_credit_expires_at),
        },
        _ => (usage_reset_credits, usage_reset_credit_expires_at),
    };

    let updated_at = chrono::Utc::now().to_rfc3339();
    let rate_limit_snapshot = weekly_window.as_ref().map(|window| RateLimitSnapshot {
        source: "legacy-api".into(),
        used_percent: (100.0 - window.remaining_percent).clamp(0.0, 100.0),
        window_duration_mins: Some(window.window_seconds / 60),
        resets_at: window.resets_at.clone(),
        observed_at: updated_at.clone(),
    });
    ProviderSnapshot {
        provider: "codex".into(),
        display_name: "CODEX".into(),
        plan: pick_string(&usage, &["plan_type", "planType"]).map(|value| value.to_uppercase()),
        short_window,
        weekly_window,
        monthly_window: None,
        reset_credits,
        reset_credit_expires_at,
        balance_remaining: None,
        balance_unit: None,
        rate_limit_snapshot,
        updated_at,
        status: "ok".into(),
        message: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_snake_and_camel_case_window_shapes() {
        let snake = serde_json::json!({
            "used_percent": 26,
            "reset_at": 1738300000,
            "limit_window_seconds": 604800
        });
        let window = parse_window(Some(&snake)).unwrap();
        assert_eq!(window.remaining_percent, 74.0);
        assert_eq!(window.window_seconds, 604800);
        let camel = serde_json::json!({
            "utilization": 0.4,
            "resetsAt": "2026-07-07T00:00:00Z",
            "windowSeconds": 604800
        });
        assert_eq!(parse_window(Some(&camel)).unwrap().remaining_percent, 60.0);
    }

    #[test]
    fn prefers_explicit_remaining_percent() {
        let value = serde_json::json!({
            "remainingPercent": 73.4,
            "usedPercent": 99,
            "resetTime": "2026-07-07T00:00:00Z",
            "durationSeconds": 604800
        });
        let window = parse_window(Some(&value)).unwrap();
        assert_eq!(window.remaining_percent, 73.4);
        assert_eq!(window.window_seconds, 604800);
    }

    #[test]
    fn treats_fractional_percent_fields_as_ratios() {
        let explicit_remaining = serde_json::json!({"remaining": 0.25, "periodSeconds": 604800});
        assert_eq!(
            parse_window(Some(&explicit_remaining))
                .unwrap()
                .remaining_percent,
            25.0
        );

        let used_ratio = serde_json::json!({"used": 0.25, "periodSeconds": 604800});
        assert_eq!(
            parse_window(Some(&used_ratio)).unwrap().remaining_percent,
            75.0
        );
    }

    #[test]
    fn does_not_scale_explicit_percent_fields() {
        let explicit_remaining =
            serde_json::json!({"remaining_percent": 0.4, "windowSeconds": 604800});
        assert_eq!(
            parse_window(Some(&explicit_remaining))
                .unwrap()
                .remaining_percent,
            0.4
        );

        let explicit_used = serde_json::json!({"used_percent": 0.4, "windowSeconds": 604800});
        assert_eq!(
            parse_window(Some(&explicit_used))
                .unwrap()
                .remaining_percent,
            99.6
        );
    }

    #[test]
    fn finds_weekly_window_by_duration_or_name_in_arrays() {
        let rate_limit = serde_json::json!({
            "windows": [
                {"name": "daily", "remainingPercent": 51, "windowSeconds": 86400},
                {"name": "weekly", "remainingPercent": 88, "windowSeconds": 604800}
            ]
        });
        let weekly = parse_window(find_window(
            &rate_limit,
            &["secondary_window", "weekly"],
            604_800,
        ))
        .unwrap();
        assert_eq!(weekly.remaining_percent, 88.0);
    }

    #[test]
    fn finds_weekly_window_when_service_exposes_it_as_primary() {
        let rate_limit = serde_json::json!({
            "primary_window": {"remainingPercent": 63, "windowSeconds": 604800}
        });
        let weekly = parse_window(find_window(
            &rate_limit,
            &["secondary_window", "weekly"],
            604_800,
        ))
        .unwrap();
        assert_eq!(weekly.remaining_percent, 63.0);
    }

    #[test]
    fn accepts_a_single_weekly_window_without_duration_metadata() {
        let rate_limit = serde_json::json!({
            "primary_window": {"remainingPercent": 63}
        });
        let weekly = parse_window(find_window(
            &rate_limit,
            &["secondary_window", "weekly"],
            604_800,
        ))
        .unwrap();
        assert_eq!(weekly.remaining_percent, 63.0);
    }

    #[test]
    fn does_not_treat_a_weekly_primary_field_as_a_short_window() {
        let value = serde_json::json!({
            "primary_window": {"remainingPercent": 98, "windowSeconds": 604800},
            "weekly_window": {"remainingPercent": 98, "windowSeconds": 604800}
        });
        assert!(find_window(&value, &["primary_window", "primary"], 18_000).is_none());
        assert!(find_window(&value, &["weekly_window", "weekly"], 604_800).is_some());
    }

    #[test]
    fn recognizes_a_weekly_primary_field_as_weekly_fallback() {
        let value = serde_json::json!({
            "primary": {"remainingPercent": 98, "windowSeconds": 604800}
        });
        let weekly = parse_window(find_window(
            &value,
            &["weekly_window", "weekly", "primary_window", "primary"],
            604_800,
        ))
        .unwrap();
        assert_eq!(weekly.remaining_percent, 98.0);
        assert_eq!(weekly.window_seconds, 604_800);
    }

    #[test]
    fn parses_official_weekly_usage_from_codex_session_events() {
        let line = serde_json::json!({
            "timestamp": "2026-08-12T07:42:12.505Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "limit_id": "codex",
                    "primary": { "used_percent": 12, "window_minutes": 300, "resets_at": 1786400000_i64 },
                    "secondary": { "used_percent": 32, "window_minutes": 10080, "resets_at": 1787011367_i64 }
                }
            }
        })
        .to_string();
        let observation = parse_weekly_observation(&line).expect("weekly observation");
        assert_eq!(observation.used_percent, 32.0);
        assert_eq!(observation.window_minutes, WEEKLY_WINDOW_MINUTES);
        assert_eq!(observation.resets_at, 1_787_011_367);
    }

    #[test]
    fn parses_official_app_server_weekly_snapshot() {
        let result = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 26,
                    "windowDurationMins": 10080,
                    "resetsAt": 1787200981_i64
                },
                "secondary": {
                    "usedPercent": 7,
                    "windowDurationMins": 300,
                    "resetsAt": 1786400000_i64
                },
                "planType": "prolite"
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {
                        "usedPercent": 26,
                        "windowDurationMins": 10080,
                        "resetsAt": 1787200981_i64
                    },
                    "secondary": {
                        "usedPercent": 7,
                        "windowDurationMins": 300,
                        "resetsAt": 1786400000_i64
                    },
                    "planType": "prolite"
                },
                "codex_bengalfox": {
                    "primary": {
                        "usedPercent": 99,
                        "windowDurationMins": 10080,
                        "resetsAt": 1787200981_i64
                    }
                }
            },
            "rateLimitResetCredits": {"availableCount": 0}
        });

        let snapshot = parse_app_server_snapshot(&result, "2026-08-13T08:30:00Z".into())
            .expect("official app-server snapshot");
        assert_eq!(snapshot.plan.as_deref(), Some("PROLITE"));
        assert_eq!(snapshot.weekly_window.unwrap().remaining_percent, 74.0);
        assert_eq!(snapshot.short_window.unwrap().remaining_percent, 93.0);
        assert_eq!(snapshot.reset_credits, Some(0));
        let official = snapshot.rate_limit_snapshot.expect("official metadata");
        assert_eq!(official.source, "app-server");
        assert_eq!(official.used_percent, 26.0);
        assert_eq!(official.window_duration_mins, Some(WEEKLY_WINDOW_MINUTES));
        assert_eq!(
            official.resets_at.as_deref(),
            Some("2026-08-20T04:43:01+00:00")
        );
    }

    #[test]
    fn does_not_mislabel_short_app_server_window_as_weekly() {
        let result = serde_json::json!({
            "rateLimits": {
                "primary": {"usedPercent": 26, "windowDurationMins": 300},
                "secondary": null
            }
        });
        let error = parse_app_server_snapshot(&result, "2026-08-13T08:30:00Z".into())
            .expect_err("short-only response should not be accepted as weekly");
        assert!(error.contains("no usable quota window"));
    }

    #[test]
    fn daily_usage_recovers_prelaunch_growth_without_counting_stale_rebounds() {
        let offset = FixedOffset::east_opt(8 * 60 * 60).expect("valid offset");
        let local_date = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid date");
        let day_start = offset
            .with_ymd_and_hms(2026, 8, 12, 4, 0, 0)
            .single()
            .expect("valid usage day start")
            .timestamp();
        let observation = |hour: u32, minute: u32, used_percent: f64| QuotaObservation {
            observed_at: offset
                .with_ymd_and_hms(2026, 8, 12, hour, minute, 0)
                .single()
                .expect("valid observation time"),
            used_percent,
            resets_at: 1_787_011_367,
            window_minutes: WEEKLY_WINDOW_MINUTES,
        };
        let summary = summarize_daily_usage(
            local_date,
            day_start,
            vec![
                observation(14, 24, 23.0),
                observation(15, 0, 30.0),
                observation(15, 1, 29.0),
                observation(18, 0, 64.0),
            ],
        );
        assert_eq!(summary.observed_used_percent, 41.0);
        assert_eq!(summary.sample_count, 4);
        assert_eq!(summary.coverage, "partial");
        assert_eq!(
            summary.first_observed_at.as_deref(),
            Some("2026-08-12T14:24:00+08:00")
        );
    }

    #[test]
    fn four_am_snapshot_marks_daily_coverage_complete() {
        let offset = FixedOffset::east_opt(8 * 60 * 60).expect("valid offset");
        let local_date = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid date");
        let day_start = offset
            .with_ymd_and_hms(2026, 8, 12, 4, 0, 0)
            .single()
            .expect("valid usage day start")
            .timestamp();
        let observations = [5_u32, 30_u32]
            .into_iter()
            .zip([10.0, 15.0])
            .map(|(minute, used_percent)| QuotaObservation {
                observed_at: offset
                    .with_ymd_and_hms(2026, 8, 12, 4, minute, 0)
                    .single()
                    .expect("valid observation time"),
                used_percent,
                resets_at: 1_787_011_367,
                window_minutes: WEEKLY_WINDOW_MINUTES,
            })
            .collect();
        let summary = summarize_daily_usage(local_date, day_start, observations);
        assert_eq!(summary.observed_used_percent, 5.0);
        assert_eq!(summary.coverage, "complete");
    }

    #[test]
    fn usage_day_rolls_over_at_four_am() {
        let local_date = NaiveDate::from_ymd_opt(2026, 8, 14).expect("valid date");
        assert_eq!(
            usage_date_for_local_time(local_date, 3),
            NaiveDate::from_ymd_opt(2026, 8, 13).expect("valid previous date")
        );
        assert_eq!(usage_date_for_local_time(local_date, 4), local_date);
    }

    #[test]
    fn usage_history_uses_beijing_time_and_adjacent_session_directories() {
        let local_date = NaiveDate::from_ymd_opt(2026, 8, 14).expect("valid date");
        let day_start = usage_day_start(local_date).expect("valid Beijing day start");
        let day_end = usage_day_end(local_date).expect("valid Beijing day end");
        assert_eq!(day_start.to_rfc3339(), "2026-08-14T04:00:00+08:00");
        assert_eq!(day_end.to_rfc3339(), "2026-08-15T04:00:00+08:00");
        assert_eq!(
            session_dates_for_usage_day(local_date).collect::<Vec<_>>(),
            vec![
                NaiveDate::from_ymd_opt(2026, 8, 14).expect("valid session date"),
                NaiveDate::from_ymd_opt(2026, 8, 15).expect("valid session date"),
            ]
        );
    }
}

use std::{
    env,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::{process::Command, time::timeout};

use crate::models::{ProviderSnapshot, UsageWindow};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

static LAST_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[derive(Clone)]
struct ArkCliProgram {
    path: PathBuf,
    source: &'static str,
    stale_path: bool,
}

#[derive(Debug)]
enum CommandFailure {
    NotFound,
    CouldNotStart,
    TimedOut,
    TooMuchData,
}

impl CommandFailure {
    fn message(&self) -> &'static str {
        match self {
            Self::NotFound => "Ark CLI is not installed or is not available to the app.",
            Self::CouldNotStart => "Ark CLI could not be started.",
            Self::TimedOut => "The Ark CLI request timed out.",
            Self::TooMuchData => "Ark CLI returned too much data.",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolcengineDiagnostics {
    pub installed: bool,
    pub executable_path: Option<String>,
    pub executable_source: Option<String>,
    pub stale_path: bool,
    pub cli_version: Option<String>,
    pub authenticated: bool,
    pub auth_method: Option<String>,
    pub profile_name: Option<String>,
    pub profile_type: Option<String>,
    pub profile_region: Option<String>,
    pub recommended_profile: bool,
    pub last_error: Option<String>,
}

fn last_error_store() -> &'static Mutex<Option<String>> {
    LAST_ERROR.get_or_init(|| Mutex::new(None))
}

fn set_last_error(message: Option<&str>) {
    if let Ok(mut value) = last_error_store().lock() {
        *value = message.map(str::to_owned);
    }
}

fn get_last_error() -> Option<String> {
    last_error_store()
        .lock()
        .ok()
        .and_then(|value| value.clone())
}

#[cfg(windows)]
fn executable_names() -> &'static [&'static str] {
    &["arkcli.cmd", "arkcli.exe", "arkcli"]
}

#[cfg(not(windows))]
fn executable_names() -> &'static [&'static str] {
    &["arkcli"]
}

fn find_on_process_path() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|directory| {
        executable_names()
            .iter()
            .map(|name| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn fallback_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    if let Some(data_dir) = dirs::data_dir() {
        candidates.push(data_dir.join("npm").join("arkcli.cmd"));
        candidates.push(data_dir.join("npm").join("arkcli.exe"));
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local").join("bin").join("arkcli"));
        }
        candidates.push(PathBuf::from("/usr/local/bin/arkcli"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/arkcli"));
    }
    candidates
}

fn resolve_arkcli() -> Option<ArkCliProgram> {
    if let Some(path) = find_on_process_path() {
        return Some(ArkCliProgram {
            path,
            source: "PATH",
            stale_path: false,
        });
    }
    fallback_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|path| ArkCliProgram {
            path,
            source: "npm fallback",
            stale_path: true,
        })
}

fn redacted_path(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(relative) = path.strip_prefix(home) {
            return Path::new("~").join(relative).display().to_string();
        }
    }
    path.display().to_string()
}

fn command_for(program: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command
}

async fn run_arkcli(
    program: &Path,
    args: &[&str],
    duration: Duration,
) -> Result<Output, CommandFailure> {
    let output = match timeout(duration, command_for(program, args).output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) if error.kind() == ErrorKind::NotFound => {
            return Err(CommandFailure::NotFound)
        }
        Ok(Err(_)) => return Err(CommandFailure::CouldNotStart),
        Err(_) => return Err(CommandFailure::TimedOut),
    };
    if output.stdout.len() > MAX_OUTPUT_BYTES || output.stderr.len() > MAX_OUTPUT_BYTES {
        return Err(CommandFailure::TooMuchData);
    }
    Ok(output)
}

fn combined_output(stdout: &[u8], stderr: &[u8]) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_ascii_lowercase()
}

fn classify_cli_failure(stdout: &[u8], stderr: &[u8]) -> (&'static str, &'static str) {
    let error = combined_output(stdout, stderr);
    let expired_login = [
        "refresh_token",
        "refresh token",
        "token exchange",
        "token 交换",
        "unauthorized",
        "not logged in",
        "login required",
        "please run `arkcli auth login",
        "请运行 `arkcli auth login",
    ]
    .iter()
    .any(|needle| error.contains(needle));
    if expired_login {
        return (
            "signed_out",
            "Volcengine login expired. Reconnect to continue.",
        );
    }
    if error.contains("accessdenied") || error.contains("permission denied") {
        return (
            "unavailable",
            "The active Volcengine identity cannot access Coding Plan quota.",
        );
    }
    if ["network", "timeout", "connection", "dns", "tls"]
        .iter()
        .any(|needle| error.contains(needle))
    {
        return (
            "unavailable",
            "Volcengine could not be reached. Check the network and retry.",
        );
    }
    (
        "unavailable",
        "Coding Plan quota is temporarily unavailable.",
    )
}

fn failure_snapshot(status: &str, message: &str) -> ProviderSnapshot {
    set_last_error(Some(message));
    ProviderSnapshot::provider_failure("volcengine", "VOLCENGINE", status, message)
}

fn find_period<'a>(periods: &'a [Value], labels: &[&str]) -> Option<&'a Value> {
    periods.iter().find(|period| {
        period
            .get("label")
            .and_then(Value::as_str)
            .is_some_and(|label| {
                labels
                    .iter()
                    .any(|candidate| label.eq_ignore_ascii_case(candidate))
            })
    })
}

fn monthly_window_seconds(reset_at: Option<&str>) -> u64 {
    reset_at
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .and_then(|reset| {
            reset
                .checked_sub_months(chrono::Months::new(1))
                .map(|start| (reset - start).num_seconds())
        })
        .filter(|seconds| *seconds > 0)
        .map(|seconds| seconds as u64)
        .unwrap_or(30 * 86_400)
}

fn parse_period(
    period: Option<&Value>,
    default_window_seconds: u64,
    calendar_month: bool,
) -> Option<UsageWindow> {
    let period = period?;
    let used_percent = period.get("percent").and_then(Value::as_f64)?;
    let resets_at = period
        .get("reset_at")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(UsageWindow {
        remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
        window_seconds: if calendar_month {
            monthly_window_seconds(resets_at.as_deref())
        } else {
            default_window_seconds
        },
        resets_at,
    })
}

fn parse_snapshot(value: &Value) -> Result<ProviderSnapshot, &'static str> {
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| value.pointer("/data/items").and_then(Value::as_array))
        .ok_or("Ark CLI returned an unsupported Coding Plan response.")?;
    let item = items
        .iter()
        .find(|item| item.get("product").and_then(Value::as_str) == Some("coding-plan"))
        .ok_or("No Coding Plan subscription was found.")?;
    if item.get("subscribed").and_then(Value::as_bool) == Some(false) {
        return Err("No active Coding Plan subscription was found.");
    }
    let periods = item
        .get("periods")
        .and_then(Value::as_array)
        .ok_or("Coding Plan response is missing quota periods.")?;
    let short_window = parse_period(
        find_period(periods, &["5h", "5hr", "session"]),
        5 * 3_600,
        false,
    );
    let weekly_window = parse_period(find_period(periods, &["weekly"]), 7 * 86_400, false)
        .ok_or("Coding Plan response is missing the weekly quota.")?;
    let monthly_window = parse_period(find_period(periods, &["monthly"]), 30 * 86_400, true);
    let updated_at = item
        .get("updated_at")
        .and_then(Value::as_i64)
        .and_then(|timestamp| {
            if timestamp.abs() >= 10_000_000_000 {
                chrono::DateTime::from_timestamp_millis(timestamp)
            } else {
                chrono::DateTime::from_timestamp(timestamp, 0)
            }
        })
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    Ok(ProviderSnapshot {
        provider: "volcengine".into(),
        display_name: "VOLCENGINE".into(),
        plan: item
            .get("edition")
            .and_then(Value::as_str)
            .map(|edition| match edition {
                "personal" => "Coding Plan Personal".to_string(),
                value => format!("Coding Plan {}", value),
            })
            .or_else(|| Some("Coding Plan".into())),
        short_window,
        weekly_window: Some(weekly_window),
        monthly_window,
        reset_credits: None,
        reset_credit_expires_at: Vec::new(),
        balance_remaining: None,
        balance_unit: None,
        rate_limit_snapshot: None,
        updated_at,
        status: "ok".into(),
        message: None,
    })
}

fn output_json(output: &Output) -> Option<Value> {
    serde_json::from_slice(&output.stdout).ok()
}

fn output_text(output: &Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    (!stderr.is_empty()).then_some(stderr)
}

pub async fn diagnostics() -> VolcengineDiagnostics {
    let Some(program) = resolve_arkcli() else {
        return VolcengineDiagnostics {
            installed: false,
            executable_path: None,
            executable_source: None,
            stale_path: false,
            cli_version: None,
            authenticated: false,
            auth_method: None,
            profile_name: None,
            profile_type: None,
            profile_region: None,
            recommended_profile: false,
            last_error: get_last_error().or_else(|| {
                Some("Ark CLI is not installed or is not available to the app.".into())
            }),
        };
    };

    let version = run_arkcli(&program.path, &["--version"], COMMAND_TIMEOUT);
    let auth = run_arkcli(
        &program.path,
        &["auth", "status", "--format", "json"],
        COMMAND_TIMEOUT,
    );
    let profile = run_arkcli(
        &program.path,
        &["profile", "show", "--format", "json"],
        COMMAND_TIMEOUT,
    );
    let (version, auth, profile) = tokio::join!(version, auth, profile);

    let cli_version = version.ok().and_then(|output| output_text(&output));
    let auth_failure = match &auth {
        Ok(output) if !output.status.success() => {
            Some(classify_cli_failure(&output.stdout, &output.stderr).1)
        }
        Err(error) => Some(error.message()),
        _ => None,
    };
    let auth_json = auth
        .as_ref()
        .ok()
        .filter(|output| output.status.success())
        .and_then(output_json);
    let authenticated = auth_json
        .as_ref()
        .and_then(|value| value.get("logged_in"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auth_method = auth_json
        .as_ref()
        .and_then(|value| value.get("auth_method"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let profile_json = profile
        .as_ref()
        .ok()
        .filter(|output| output.status.success())
        .and_then(output_json);
    let profile_name = profile_json
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let profile_type = profile_json
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let profile_region = profile_json
        .as_ref()
        .and_then(|value| value.get("region"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let recommended_profile = matches!(
        profile_type.as_deref(),
        Some("coding-plan" | "coding-plan-team")
    );

    VolcengineDiagnostics {
        installed: true,
        executable_path: Some(redacted_path(&program.path)),
        executable_source: Some(program.source.into()),
        stale_path: program.stale_path,
        cli_version,
        authenticated,
        auth_method,
        profile_name,
        profile_type,
        profile_region,
        recommended_profile,
        last_error: get_last_error().or_else(|| auth_failure.map(str::to_owned)),
    }
}

pub async fn reconnect() -> Result<(), String> {
    let program = resolve_arkcli()
        .ok_or_else(|| "Ark CLI is not installed or is not available to the app.".to_string())?;
    let output =
        match run_arkcli(&program.path, &["auth", "login", "volc-sso"], LOGIN_TIMEOUT).await {
            Ok(output) => output,
            Err(error) => {
                let message = error.message();
                set_last_error(Some(message));
                return Err(message.into());
            }
        };
    if !output.status.success() {
        let (_, message) = classify_cli_failure(&output.stdout, &output.stderr);
        set_last_error(Some(message));
        return Err(message.into());
    }
    set_last_error(None);
    Ok(())
}

pub async fn fetch_snapshot() -> Option<ProviderSnapshot> {
    let program = match resolve_arkcli() {
        Some(program) => program,
        None => {
            set_last_error(Some(
                "Ark CLI is not installed or is not available to the app.",
            ));
            return None;
        }
    };
    let output = match run_arkcli(
        &program.path,
        &[
            "usage",
            "plan",
            "--product",
            "coding-plan",
            "--format",
            "json",
        ],
        COMMAND_TIMEOUT,
    )
    .await
    {
        Ok(output) => output,
        Err(CommandFailure::NotFound) => return None,
        Err(error) => return Some(failure_snapshot("unavailable", error.message())),
    };
    if !output.status.success() {
        let (status, message) = classify_cli_failure(&output.stdout, &output.stderr);
        return Some(failure_snapshot(status, message));
    }
    let value: Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(_) => {
            return Some(failure_snapshot(
                "unavailable",
                "Ark CLI returned an unsupported response.",
            ))
        }
    };
    Some(match parse_snapshot(&value) {
        Ok(snapshot) => {
            set_last_error(None);
            snapshot
        }
        Err(message) => failure_snapshot("unavailable", message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_cli_coding_plan_shape() {
        let value = serde_json::json!({
            "items": [{
                "product": "coding-plan",
                "edition": "personal",
                "subscribed": true,
                "periods": [
                    {"label": "session", "percent": 0},
                    {"label": "weekly", "percent": 27.54661526666667, "reset_at": "2026-07-20T00:00:00+08:00"},
                    {"label": "monthly", "percent": 43.29508606666666, "reset_at": "2026-08-09T23:59:59+08:00"}
                ],
                "updated_at": 1_784_306_543
            }]
        });
        let snapshot = parse_snapshot(&value).unwrap();
        assert_eq!(snapshot.plan.as_deref(), Some("Coding Plan Personal"));
        assert_eq!(
            snapshot.short_window.as_ref().unwrap().remaining_percent,
            100.0
        );
        assert!(
            (snapshot.weekly_window.as_ref().unwrap().remaining_percent - 72.45338473333333).abs()
                < 0.000_001
        );
        let monthly = snapshot.monthly_window.as_ref().unwrap();
        assert!((monthly.remaining_percent - 56.70491393333334).abs() < 0.000_001);
        assert_eq!(monthly.window_seconds, 31 * 86_400);
        assert_eq!(snapshot.status, "ok");
    }

    #[test]
    fn accepts_millisecond_updated_timestamp() {
        let value = serde_json::json!({
            "items": [{
                "product": "coding-plan",
                "subscribed": true,
                "periods": [{"label": "weekly", "percent": 15}],
                "updated_at": 1_784_306_543_000_i64
            }]
        });
        let snapshot = parse_snapshot(&value).unwrap();
        assert!(snapshot.updated_at.starts_with("2026-07-17T"));
    }

    #[test]
    fn classifies_expired_login_from_json_stdout() {
        let stdout = br#"{
            "ok": false,
            "error": {
                "message": "token exchange failed: invalid_request - refresh_token is invalid; please run `arkcli auth login volc-sso`"
            }
        }"#;
        assert_eq!(
            classify_cli_failure(stdout, b""),
            (
                "signed_out",
                "Volcengine login expired. Reconnect to continue."
            )
        );
    }

    #[test]
    fn classifies_expired_login_from_stderr() {
        assert_eq!(
            classify_cli_failure(b"", b"unauthorized: login required"),
            (
                "signed_out",
                "Volcengine login expired. Reconnect to continue."
            )
        );
    }
}

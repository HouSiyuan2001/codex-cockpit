//! Read-only Google Antigravity quota pools (`Gemini Models` and
//! `Claude and GPT models`), each with a 5-hour and weekly remaining balance.
//!
//! Antigravity's documented CLI status-line hook supplies the quota buckets.
//! The hook persists only the parsed quotas and observation time, never the
//! raw payload, which can contain identifying session and account metadata.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const MAX_FIXTURE_BYTES: u64 = 64 * 1024;
const MIN_REFRESH: Duration = Duration::from_secs(55);
const MIN_MANUAL_REFRESH: Duration = Duration::from_secs(10);
const FAILURE_BACKOFF: Duration = Duration::from_secs(55);
const STATUSLINE_FRESHNESS_MINUTES: i64 = 15;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeminiQuotaWindow {
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeminiQuotaPool {
    pub five_hour: Option<GeminiQuotaWindow>,
    pub weekly: Option<GeminiQuotaWindow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeminiQuota {
    /// ok | stale | signed_out | unavailable
    pub status: &'static str,
    pub gemini: Option<GeminiQuotaPool>,
    pub claude_gpt: Option<GeminiQuotaPool>,
    pub plan: Option<String>,
    pub observed_at: Option<String>,
    pub message: Option<&'static str>,
}

impl GeminiQuota {
    pub fn failure(status: &'static str, message: &'static str) -> Self {
        Self {
            status,
            gemini: None,
            claude_gpt: None,
            plan: None,
            observed_at: Some(Utc::now().to_rfc3339()),
            message: Some(message),
        }
    }
}

#[derive(Default)]
struct QuotaState {
    last_good: Option<GeminiQuota>,
    last_attempt: Option<(Instant, DateTime<Utc>)>,
    last_result: Option<GeminiQuota>,
    backoff_until: Option<Instant>,
}

static STATE: Mutex<Option<QuotaState>> = Mutex::const_new(None);

fn clamp_percent(value: &Value) -> Option<f64> {
    let number = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    number.is_finite().then(|| number.clamp(0.0, 100.0))
}

fn fraction_to_percent(value: &Value) -> Option<f64> {
    let number = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    number
        .is_finite()
        .then(|| (number * 100.0).clamp(0.0, 100.0))
}

fn valid_rfc3339(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc).to_rfc3339())
}

fn parse_window(item: &Value) -> Option<GeminiQuotaWindow> {
    let remaining_percent = item
        .get("remainingPercent")
        .or_else(|| item.get("remaining_percent"))
        .and_then(clamp_percent)
        .or_else(|| {
            item.get("remainingFraction")
                .or_else(|| item.get("remaining_fraction"))
                .and_then(fraction_to_percent)
        })?;
    // Never estimate or synthesize a reset timestamp when the source omits it.
    let resets_at = valid_rfc3339(item.get("resetsAt").or_else(|| item.get("reset_time")));
    Some(GeminiQuotaWindow {
        remaining_percent,
        resets_at,
    })
}

fn parse_pool(pool: &Value) -> Option<GeminiQuotaPool> {
    let five_hour = pool
        .get("fiveHour")
        .or_else(|| pool.get("five_hour"))
        .and_then(parse_window);
    let weekly = pool.get("weekly").and_then(parse_window);
    (five_hour.is_some() || weekly.is_some()).then_some(GeminiQuotaPool { five_hour, weekly })
}

fn bucket_window(buckets: &Value, keys: &[&str]) -> Option<GeminiQuotaWindow> {
    keys.iter()
        .filter_map(|key| buckets.get(*key))
        .filter(|window| window.get("disabled").and_then(Value::as_bool) != Some(true))
        .find_map(parse_window)
}

pub fn parse_quota(raw: &Value, observed_at: String) -> Option<GeminiQuota> {
    if let Some(status) = raw.get("status").and_then(Value::as_str) {
        match status {
            "signed_out" => {
                return Some(GeminiQuota::failure(
                    "signed_out",
                    "Antigravity login not found.",
                ));
            }
            "unavailable" => {
                return Some(GeminiQuota::failure(
                    "unavailable",
                    "Antigravity quota is temporarily unavailable.",
                ));
            }
            _ => {}
        }
    }

    let direct_gemini = raw.get("gemini").and_then(parse_pool);
    let direct_claude_gpt = raw
        .get("claudeGpt")
        .or_else(|| raw.get("claude_gpt"))
        .and_then(parse_pool);

    let (gemini, claude_gpt) = if direct_gemini.is_some() || direct_claude_gpt.is_some() {
        (direct_gemini, direct_claude_gpt)
    } else if let Some(buckets) = raw.get("quota") {
        let gemini_five_hour =
            bucket_window(buckets, &["gemini-5h", "gemini-five-hour", "gemini_5h"]);
        let gemini_weekly = bucket_window(buckets, &["gemini-weekly", "gemini_weekly"]);
        let shared_five_hour = bucket_window(
            buckets,
            &[
                "3p-5h",
                "claude-gpt-5h",
                "claude-and-gpt-5h",
                "claude_gpt_5h",
                "partner-5h",
            ],
        );
        let shared_weekly = bucket_window(
            buckets,
            &[
                "3p-weekly",
                "claude-gpt-weekly",
                "claude-and-gpt-weekly",
                "claude_gpt_weekly",
                "partner-weekly",
            ],
        );
        let gemini =
            (gemini_five_hour.is_some() || gemini_weekly.is_some()).then_some(GeminiQuotaPool {
                five_hour: gemini_five_hour,
                weekly: gemini_weekly,
            });
        let claude_gpt =
            (shared_five_hour.is_some() || shared_weekly.is_some()).then_some(GeminiQuotaPool {
                five_hour: shared_five_hour,
                weekly: shared_weekly,
            });
        (gemini, claude_gpt)
    } else {
        (None, None)
    };

    if gemini.is_none() && claude_gpt.is_none() {
        return None;
    }

    let plan = raw
        .get("plan")
        .or_else(|| raw.get("plan_tier"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(48).collect());

    let status = match raw.get("status").and_then(Value::as_str) {
        Some("stale") => "stale",
        _ => "ok",
    };

    Some(GeminiQuota {
        status,
        gemini,
        claude_gpt,
        plan,
        observed_at: Some(observed_at),
        message: if status == "stale" {
            Some("Antigravity quota snapshot is stale.")
        } else {
            None
        },
    })
}

fn read_synthetic_fixture(path: &Path) -> Result<GeminiQuota, (&'static str, &'static str)> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| ("unavailable", "Synthetic Gemini fixture could not be read."))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_FIXTURE_BYTES
    {
        return Err(("unavailable", "Synthetic Gemini fixture is invalid."));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|_| ("unavailable", "Synthetic Gemini fixture could not be read."))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| ("unavailable", "Synthetic Gemini fixture format is invalid."))?;
    parse_quota(&value, Utc::now().to_rfc3339()).ok_or((
        "unavailable",
        "Synthetic Gemini fixture has no quota pools.",
    ))
}

impl QuotaState {
    fn reset_timestamps(result: &GeminiQuota) -> impl Iterator<Item = &str> {
        [
            result
                .gemini
                .as_ref()
                .and_then(|pool| pool.five_hour.as_ref()),
            result.gemini.as_ref().and_then(|pool| pool.weekly.as_ref()),
            result
                .claude_gpt
                .as_ref()
                .and_then(|pool| pool.five_hour.as_ref()),
            result
                .claude_gpt
                .as_ref()
                .and_then(|pool| pool.weekly.as_ref()),
        ]
        .into_iter()
        .flatten()
        .filter_map(|window| window.resets_at.as_deref())
    }

    fn cached_result(
        &self,
        now: Instant,
        wall_time: DateTime<Utc>,
        manual: bool,
    ) -> Option<GeminiQuota> {
        let (last_attempt, last_wall_time) = self.last_attempt?;
        let result = self.last_result.as_ref()?;
        let elapsed = now.duration_since(last_attempt);
        let manual_ready = manual && elapsed >= MIN_MANUAL_REFRESH;
        if self.backoff_until.is_some_and(|until| now < until) && !manual_ready {
            return Some(result.clone());
        }
        let crossed_reset = Self::reset_timestamps(result)
            .filter_map(|value| DateTime::parse_from_rfc3339(value).ok())
            .any(|reset| last_wall_time < reset && wall_time >= reset);
        (elapsed < MIN_REFRESH && !manual_ready && !crossed_reset).then(|| result.clone())
    }

    fn finish_attempt(
        &mut self,
        outcome: Result<GeminiQuota, (&'static str, &'static str)>,
    ) -> GeminiQuota {
        let result = match outcome {
            Ok(quota) => {
                if quota.status == "ok" {
                    self.last_good = Some(quota.clone());
                } else if quota.status == "signed_out" {
                    self.last_good = None;
                }
                self.backoff_until = None;
                quota
            }
            Err(("signed_out", message)) => {
                self.last_good = None;
                GeminiQuota::failure("signed_out", message)
            }
            Err((status, message)) => match &self.last_good {
                Some(good) => GeminiQuota {
                    status: "stale",
                    message: Some(message),
                    ..good.clone()
                },
                None => GeminiQuota::failure(status, message),
            },
        };
        self.last_result = Some(result.clone());
        result
    }
}

fn statusline_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".gemini/antigravity-cli/codex-cockpit-account-quota.json"))
}

#[cfg(windows)]
fn windows_statusline_command(exe: &Path) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    // Antigravity passes the hook through cmd.exe. Keep the path and script
    // out of cmd's quote handling, and forward the original JSON bytes.
    let exe = exe.to_str()?.replace('\'', "''");
    let script = format!(
        r#"$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = '{exe}'
$start.Arguments = '--antigravity-statusline'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$child = [System.Diagnostics.Process]::Start($start)
try {{
    [Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)
}} finally {{
    $child.StandardInput.Close()
}}
$child.WaitForExit()
exit $child.ExitCode"#
    );
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    Some(format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    ))
}

#[cfg(windows)]
fn is_windows_cockpit_statusline(command: &str) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine};

    if let Some(path) = command
        .strip_prefix("\"\"")
        .and_then(|value| value.strip_suffix("\" --antigravity-statusline\""))
    {
        return Path::new(path).is_absolute()
            && Path::new(path)
                .file_name()
                .is_some_and(|name| name == "quota-float.exe");
    }
    let Some(bytes) = command
        .strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
        .and_then(|encoded| STANDARD.decode(encoded).ok())
    else {
        return false;
    };
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return false;
    }
    let words: Vec<_> = pairs.iter().copied().map(u16::from_le_bytes).collect();
    let Ok(script) = String::from_utf16(&words) else {
        return false;
    };
    let Some(path) = script.lines().nth(1).and_then(|line| {
        line.strip_prefix("$start.FileName = '")
            .and_then(|value| value.strip_suffix('\''))
    }) else {
        return false;
    };
    windows_statusline_command(Path::new(&path.replace("''", "'"))).as_deref() == Some(command)
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_statusline_command(exe: &Path) -> Option<String> {
    let exe = exe.to_str()?.replace('\'', "'\"'\"'");
    Some(format!(
        "exec '{exe}' --antigravity-statusline # Codex Cockpit"
    ))
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn is_linux_cockpit_statusline(command: &str) -> bool {
    command.starts_with("exec '") && command.ends_with("' --antigravity-statusline # Codex Cockpit")
}

#[cfg(any(windows, target_os = "linux", test))]
fn add_statusline(
    settings: &mut Value,
    command: &str,
    is_managed: impl FnOnce(&str) -> bool,
) -> bool {
    let Some(settings) = settings.as_object_mut() else {
        return false;
    };
    if let Some(existing) = settings.get_mut("statusLine") {
        if existing["command"]
            .as_str()
            .is_some_and(|old| old != command && is_managed(old))
        {
            existing["command"] = Value::String(command.into());
            return true;
        }
        return false;
    }
    settings.insert(
        "statusLine".into(),
        serde_json::json!({
            "type": "command", "command": command, "stack_with_default": true
        }),
    );
    true
}

#[cfg(any(windows, target_os = "linux"))]
fn register_statusline() {
    let Some(settings_path) = statusline_path().map(|path| path.with_file_name("settings.json"))
    else {
        return;
    };
    // The CLI only saves non-default settings. It may have initialized its
    // directory without creating settings.json.
    let mut settings = match std::fs::symlink_metadata(&settings_path) {
        Ok(_) => match crate::tokei_usage::read_json(&settings_path, MAX_FIXTURE_BYTES) {
            Ok(settings) => settings,
            Err(_) => return,
        },
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && settings_path.parent().is_some_and(Path::is_dir) =>
        {
            serde_json::json!({})
        }
        Err(_) => return,
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    #[cfg(windows)]
    let (command, is_managed) = (
        windows_statusline_command(&exe),
        is_windows_cockpit_statusline,
    );
    #[cfg(target_os = "linux")]
    let (command, is_managed) = {
        // current_exe points to a temporary mount when launched from an AppImage.
        let exe = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .unwrap_or(exe);
        (linux_statusline_command(&exe), is_linux_cockpit_statusline)
    };
    let Some(command) = command else {
        return;
    };
    if add_statusline(&mut settings, &command, is_managed) {
        let _ = crate::usage_sync::write_json(&settings_path, &settings);
    }
}

pub(crate) fn capture_statusline_quota() {
    let Some(path) = statusline_path() else {
        return;
    };
    let mut input = Vec::new();
    if std::io::stdin()
        .take(MAX_FIXTURE_BYTES + 1)
        .read_to_end(&mut input)
        .is_err()
        || input.len() as u64 > MAX_FIXTURE_BYTES
    {
        return;
    }
    let Ok(raw) = serde_json::from_slice::<Value>(&input) else {
        return;
    };
    if let Some(quota) = authenticated_statusline_quota(&raw, Utc::now().to_rfc3339()) {
        let _ = crate::usage_sync::write_json(&path, &quota);
    }
}

fn authenticated_statusline_quota(raw: &Value, observed_at: String) -> Option<GeminiQuota> {
    let quota = raw.get("quota").filter(|quota| quota.is_object())?;
    let account = raw.get("email").and_then(Value::as_str)?;
    let (local, domain) = account.trim().split_once('@')?;
    // Before login the CLI can expose placeholder quota amounts.
    if raw.get("product").and_then(Value::as_str) != Some("antigravity")
        || local.is_empty()
        || domain.is_empty()
        || raw.get("agent_state").and_then(Value::as_str) == Some("authenticating")
    {
        return None;
    }
    parse_quota(&serde_json::json!({ "quota": quota }), observed_at)
}

fn read_statusline_quota(now: DateTime<Utc>) -> Option<GeminiQuota> {
    let path = statusline_path()?;
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FIXTURE_BYTES {
        return None;
    }
    let mut input = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_FIXTURE_BYTES + 1)
        .read_to_end(&mut input)
        .ok()?;
    if input.len() as u64 > MAX_FIXTURE_BYTES {
        return None;
    }
    let mut raw: Value = serde_json::from_slice(&input).ok()?;
    let observed = valid_rfc3339(raw.get("observedAt"))?;
    let observed_time = DateTime::parse_from_rfc3339(&observed).ok()?;
    let age = now.signed_duration_since(observed_time);
    if age < chrono::Duration::zero() {
        return None;
    }
    if age > chrono::Duration::minutes(STATUSLINE_FRESHNESS_MINUTES) {
        raw["status"] = Value::String("stale".into());
    }
    parse_quota(&raw, observed)
}

pub async fn fetch(manual: bool) -> GeminiQuota {
    let mut guard = STATE.lock().await;
    let state = guard.get_or_insert_with(QuotaState::default);
    let now = Instant::now();
    let wall_time = Utc::now();

    let fixture_path = std::env::var_os("CODEX_COCKPIT_GEMINI_FIXTURE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty());

    if fixture_path.is_none() {
        #[cfg(any(windows, target_os = "linux"))]
        if state.last_attempt.is_none() {
            register_statusline();
        }
        if let Some(quota) = read_statusline_quota(wall_time) {
            state.last_attempt = Some((now, wall_time));
            return state.finish_attempt(Ok(quota));
        }
        if let Some(cached) = state.cached_result(now, wall_time, manual) {
            return cached;
        }
    }
    state.last_attempt = Some((now, wall_time));

    if let Some(path) = fixture_path {
        let outcome = read_synthetic_fixture(&path);
        return state.finish_attempt(outcome);
    }

    #[cfg(any(windows, target_os = "linux"))]
    register_statusline();
    state.backoff_until = Some(now + FAILURE_BACKOFF);
    state.finish_attempt(Err((
        "unavailable",
        "Waiting for an Antigravity CLI quota snapshot.",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn registers_quoted_callback_without_replacing_an_existing_hook() {
        use base64::{engine::general_purpose::STANDARD, Engine};

        let path = Path::new(r"D:\Apps %Local%\Codex's Cockpit\quota-float.exe");
        let command = windows_statusline_command(path).unwrap();
        let encoded = command
            .strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
            .unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        let (pairs, remainder) = bytes.as_chunks::<2>();
        assert!(remainder.is_empty());
        let words: Vec<_> = pairs.iter().copied().map(u16::from_le_bytes).collect();
        let script = String::from_utf16(&words).unwrap();
        assert!(script.contains(r"D:\Apps %Local%\Codex''s Cockpit\quota-float.exe"));
        let old = r#"""D:\Old Apps\Codex Cockpit\quota-float.exe" --antigravity-statusline""#;
        let mut settings = serde_json::json!({"theme": "dark"});
        assert!(add_statusline(
            &mut settings,
            &command,
            is_windows_cockpit_statusline
        ));
        assert_eq!(settings["theme"], "dark");
        let mut legacy = serde_json::json!({"statusLine": {"enabled": false, "command": old}});
        assert!(add_statusline(
            &mut legacy,
            &command,
            is_windows_cockpit_statusline
        ));
        assert_eq!(legacy["statusLine"]["enabled"], false);
        assert_eq!(legacy["statusLine"]["command"], command);
        let moved =
            windows_statusline_command(Path::new(r"E:\New Install\quota-float.exe")).unwrap();
        assert!(add_statusline(
            &mut settings,
            &moved,
            is_windows_cockpit_statusline
        ));
        assert_eq!(settings["statusLine"]["command"], moved);
        let mut custom = serde_json::json!({"statusLine": {"enabled": false, "command": "custom"}});
        let before = custom.clone();
        assert!(!add_statusline(
            &mut custom,
            &command,
            is_windows_cockpit_statusline
        ));
        assert_eq!(custom, before);
    }

    #[cfg(unix)]
    #[test]
    fn quotes_appimage_paths_and_only_replaces_cockpit_hooks() {
        let path = Path::new("/home/test/Codex's Apps/Cockpit $1.AppImage");
        let command = linux_statusline_command(path).unwrap();
        let arguments = command.strip_prefix("exec ").unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf '%s\\n' {arguments}")])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{}\n--antigravity-statusline\n", path.display())
        );

        let mut settings = serde_json::json!({"theme": "dark"});
        assert!(add_statusline(
            &mut settings,
            &command,
            is_linux_cockpit_statusline
        ));
        let new = linux_statusline_command(Path::new("/usr/bin/quota-float")).unwrap();
        assert!(add_statusline(
            &mut settings,
            &new,
            is_linux_cockpit_statusline
        ));
        assert_eq!(settings["statusLine"]["command"], new);
        assert_eq!(settings["theme"], "dark");

        let mut custom = serde_json::json!({"statusLine": {"command": "custom"}});
        assert!(!add_statusline(
            &mut custom,
            &command,
            is_linux_cockpit_statusline
        ));
        assert_eq!(custom["statusLine"]["command"], "custom");
    }

    #[test]
    fn rejects_signed_out_placeholders_and_reads_both_authenticated_model_groups() {
        let mut payload = serde_json::json!({
            "product": "antigravity",
            "quota": {
                "gemini-5h": { "remaining_fraction": 0.65 },
                "gemini-weekly": { "remaining_fraction": 0.78 },
                "3p-5h": { "remaining_fraction": 0.91 },
                "3p-weekly": { "remaining_fraction": 0.83 }
            }
        });
        assert!(authenticated_statusline_quota(&payload, "now".into()).is_none());
        payload["email"] = serde_json::json!("test@example.invalid");
        let quota = authenticated_statusline_quota(&payload, "now".into()).unwrap();
        assert_eq!(
            quota.gemini.unwrap().weekly.unwrap().remaining_percent,
            78.0
        );
        assert_eq!(
            quota
                .claude_gpt
                .unwrap()
                .five_hour
                .unwrap()
                .remaining_percent,
            91.0
        );
    }

    #[test]
    fn parses_two_pool_windows_without_fabricating_reset_times() {
        let payload = serde_json::json!({
            "plan": "Google AI Pro",
            "gemini": {
                "fiveHour": { "remainingPercent": 82.5, "resetsAt": "2026-11-26T10:00:00Z" },
                "weekly": { "remainingPercent": 64.0, "resetsAt": null }
            },
            "claudeGpt": {
                "fiveHour": { "remainingPercent": 91.0 },
                "weekly": { "remainingPercent": 73.2, "resetsAt": "not-a-timestamp" }
            }
        });
        let parsed = parse_quota(&payload, "2026-11-26T05:30:00Z".into()).unwrap();
        assert_eq!(parsed.status, "ok");
        assert_eq!(parsed.plan.as_deref(), Some("Google AI Pro"));
        let gemini = parsed.gemini.unwrap();
        assert_eq!(gemini.five_hour.as_ref().unwrap().remaining_percent, 82.5);
        assert_eq!(
            gemini.five_hour.as_ref().unwrap().resets_at.as_deref(),
            Some("2026-11-26T10:00:00+00:00")
        );
        assert_eq!(gemini.weekly.as_ref().unwrap().remaining_percent, 64.0);
        assert_eq!(gemini.weekly.as_ref().unwrap().resets_at, None);

        let shared = parsed.claude_gpt.unwrap();
        assert_eq!(shared.five_hour.as_ref().unwrap().remaining_percent, 91.0);
        assert_eq!(shared.five_hour.as_ref().unwrap().resets_at, None);
        assert_eq!(shared.weekly.as_ref().unwrap().remaining_percent, 73.2);
        assert_eq!(shared.weekly.as_ref().unwrap().resets_at, None);
    }

    #[test]
    fn parses_statusline_quota_buckets_and_clamps_percentages() {
        let payload = serde_json::json!({
            "plan_tier": "Pro",
            "quota": {
                "gemini-5h": { "remaining_fraction": 1.2 },
                "gemini-weekly": { "remaining_fraction": 0.9378, "reset_time": "2026-11-30T07:50:32Z" },
                "claude-gpt-5h": { "remaining_fraction": 0.55 },
                "claude-gpt-weekly": { "remaining_fraction": -0.1 }
            }
        });
        let parsed = parse_quota(&payload, "2026-11-26T05:30:00Z".into()).unwrap();
        assert_eq!(parsed.plan.as_deref(), Some("Pro"));
        let gemini = parsed.gemini.unwrap();
        assert_eq!(gemini.five_hour.unwrap().remaining_percent, 100.0);
        let weekly = gemini.weekly.unwrap();
        assert!((weekly.remaining_percent - 93.78).abs() < 1e-6);
        assert_eq!(
            weekly.resets_at.as_deref(),
            Some("2026-11-30T07:50:32+00:00")
        );
        let shared = parsed.claude_gpt.unwrap();
        assert!((shared.five_hour.unwrap().remaining_percent - 55.0).abs() < 1e-6);
        assert_eq!(shared.weekly.unwrap().remaining_percent, 0.0);
        assert!(parse_quota(&serde_json::json!({"unexpected": true}), "now".into()).is_none());
    }

    #[test]
    fn preserves_last_good_as_stale_and_clears_on_signed_out() {
        let started = Instant::now();
        let observed = "2026-11-26T05:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let good = parse_quota(
            &serde_json::json!({
                "gemini": { "fiveHour": { "remainingPercent": 75.0 } }
            }),
            observed.to_rfc3339(),
        )
        .unwrap();
        let mut state = QuotaState {
            last_attempt: Some((started, observed)),
            last_good: Some(good),
            ..QuotaState::default()
        };
        let stale = state.finish_attempt(Err(("unavailable", "Temporary error.")));
        assert_eq!(stale.status, "stale");
        assert_eq!(
            stale.gemini.unwrap().five_hour.unwrap().remaining_percent,
            75.0
        );

        let signed_out = state.finish_attempt(Err(("signed_out", "Sign in required.")));
        assert_eq!(signed_out.status, "signed_out");
        assert!(signed_out.gemini.is_none());
        assert!(state.last_good.is_none());
    }

    #[test]
    fn refreshes_after_crossing_a_window_reset_boundary() {
        let started = Instant::now();
        let observed = "2026-11-26T09:59:55Z".parse::<DateTime<Utc>>().unwrap();
        let reset = "2026-11-26T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let quota = parse_quota(
            &serde_json::json!({
                "claudeGpt": { "fiveHour": { "remainingPercent": 15.0, "resetsAt": reset.to_rfc3339() } }
            }),
            observed.to_rfc3339(),
        )
        .unwrap();
        let state = QuotaState {
            last_attempt: Some((started, observed)),
            last_result: Some(quota),
            ..QuotaState::default()
        };
        assert!(state.cached_result(started, observed, false).is_some());
        assert!(state
            .cached_result(started + Duration::from_secs(5), reset, false)
            .is_none());
    }
}

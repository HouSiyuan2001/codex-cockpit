use crate::models::{ProviderSnapshot, UsageWindow};
use chrono::{DateTime, Utc};
use serde::Deserialize;
#[cfg(windows)]
use serde_json::Value;
use std::{collections::BTreeSet, io::ErrorKind, path::PathBuf, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_COMMAND_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const USER_STATUS_PATH: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

#[derive(Debug)]
struct LocalServer {
    pid: u32,
    csrf_token: String,
    hinted_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserStatusResponse {
    user_status: Option<UserStatus>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserStatus {
    plan_status: Option<PlanStatus>,
    user_tier: Option<UserTier>,
    cascade_model_config_data: Option<CascadeModelConfigData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserTier {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStatus {
    plan_info: Option<PlanInfo>,
    available_prompt_credits: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInfo {
    plan_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CascadeModelConfigData {
    #[serde(default)]
    client_model_configs: Vec<ClientModelConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientModelConfig {
    quota_info: Option<QuotaInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaInfo {
    remaining_fraction: f64,
    reset_time: Option<String>,
}

#[derive(Clone)]
struct QuotaCandidate {
    remaining_percent: f64,
    resets_at: Option<String>,
    seconds_until_reset: Option<i64>,
}

fn command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command
}

async fn command_output(program: &str, args: &[&str]) -> Result<Vec<u8>, ()> {
    let output = match timeout(COMMAND_TIMEOUT, command(program, args).output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) if error.kind() == ErrorKind::NotFound => return Err(()),
        Ok(Err(_)) | Err(_) => return Err(()),
    };
    if !output.status.success() || output.stdout.len() > MAX_COMMAND_BYTES {
        return Err(());
    }
    Ok(output.stdout)
}

fn argument(command_line: &str, name: &str) -> Option<String> {
    let start = command_line.find(name)? + name.len();
    let tail = command_line[start..].trim_start();
    let tail = tail.strip_prefix('=').unwrap_or(tail).trim_start();
    if tail.is_empty() {
        return None;
    }
    let (value, _) = match tail.as_bytes()[0] {
        b'"' => {
            let rest = &tail[1..];
            let end = rest.find('"').unwrap_or(rest.len());
            (&rest[..end], end)
        }
        b'\'' => {
            let rest = &tail[1..];
            let end = rest.find('\'').unwrap_or(rest.len());
            (&rest[..end], end)
        }
        _ => {
            let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
            (&tail[..end], end)
        }
    };
    (!value.is_empty()).then(|| value.to_string())
}

fn server_from_parts(pid: u32, command_line: &str) -> Option<LocalServer> {
    let csrf_token = argument(command_line, "--csrf_token")?;
    let hinted_port = argument(command_line, "--extension_server_port")
        .and_then(|value| value.parse::<u16>().ok());
    Some(LocalServer {
        pid,
        csrf_token,
        hinted_port,
    })
}

#[cfg(windows)]
async fn discover_server() -> Result<LocalServer, ()> {
    let script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -notmatch '^(powershell|pwsh|cmd|wmic)' -and ($_.Name -like 'language_server*' -or ($_.CommandLine -like '*antigravity*' -and $_.CommandLine -like '*--csrf_token*')) } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    let output = command_output(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
    .await?;
    let value: Value = serde_json::from_slice(&output).map_err(|_| ())?;
    let candidates: Vec<&Value> = match &value {
        Value::Array(values) => values.iter().collect(),
        Value::Object(_) => vec![&value],
        _ => Vec::new(),
    };
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let pid = candidate.get("ProcessId")?.as_u64()?.try_into().ok()?;
            let command_line = candidate.get("CommandLine")?.as_str()?;
            server_from_parts(pid, command_line)
        })
        .max_by_key(|server| (server.hinted_port.is_some(), server.pid))
        .ok_or(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn discover_server() -> Result<LocalServer, ()> {
    let output = command_output("ps", &["-ax", "-o", "pid=,command="]).await?;
    String::from_utf8_lossy(&output)
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("antigravity")
                && (lower.contains("language_server") || lower.contains("--csrf_token"))
        })
        .filter_map(|line| {
            let line = line.trim_start();
            let split = line.find(char::is_whitespace)?;
            let pid = line[..split].parse().ok()?;
            server_from_parts(pid, line[split..].trim_start())
        })
        .max_by_key(|server| (server.hinted_port.is_some(), server.pid))
        .ok_or(())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn discover_server() -> Result<LocalServer, ()> {
    Err(())
}

fn port_from_address(address: &str) -> Option<u16> {
    address
        .trim_matches(|character| character == '[' || character == ']')
        .rsplit(':')
        .next()?
        .parse()
        .ok()
}

#[cfg(windows)]
async fn listening_ports(pid: u32) -> Vec<u16> {
    let Ok(output) = command_output("netstat", &["-ano", "-p", "tcp"]).await else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            (parts.len() >= 5
                && parts[0].eq_ignore_ascii_case("TCP")
                && parts[3].eq_ignore_ascii_case("LISTENING")
                && parts[4].parse::<u32>().ok() == Some(pid))
            .then(|| port_from_address(parts[1]))
            .flatten()
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn listening_ports(pid: u32) -> Vec<u16> {
    let pid = pid.to_string();
    let Ok(output) =
        command_output("lsof", &["-nP", "-a", "-p", &pid, "-iTCP", "-sTCP:LISTEN"]).await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split_whitespace().collect();
            let listen = parts.iter().position(|part| *part == "(LISTEN)")?;
            (listen > 0)
                .then(|| port_from_address(parts[listen - 1]))
                .flatten()
        })
        .collect()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn listening_ports(_pid: u32) -> Vec<u16> {
    Vec::new()
}

fn is_installed() -> bool {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .is_some_and(|root| {
                root.join("Programs")
                    .join("antigravity")
                    .join("Antigravity.exe")
                    .is_file()
            })
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Applications/Antigravity.app").is_dir()
            || dirs::home_dir()
                .is_some_and(|home| home.join("Applications").join("Antigravity.app").is_dir())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

async fn limited_json(mut response: reqwest::Response) -> Result<UserStatusResponse, ()> {
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

async fn request_status(
    client: &reqwest::Client,
    protocol: &str,
    port: u16,
    csrf_token: &str,
) -> Result<UserStatusResponse, reqwest::StatusCode> {
    let url = format!("{protocol}://127.0.0.1:{port}{USER_STATUS_PATH}");
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("X-Codeium-Csrf-Token", csrf_token)
        .body(
            r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}"#,
        )
        .send()
        .await
        .map_err(|_| reqwest::StatusCode::SERVICE_UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err(response.status());
    }
    limited_json(response)
        .await
        .map_err(|_| reqwest::StatusCode::UNPROCESSABLE_ENTITY)
}

fn quota_candidate(quota: &QuotaInfo, now: DateTime<Utc>) -> QuotaCandidate {
    let seconds_until_reset = quota
        .reset_time
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|reset| {
            reset
                .with_timezone(&Utc)
                .signed_duration_since(now)
                .num_seconds()
        });
    QuotaCandidate {
        remaining_percent: (quota.remaining_fraction * 100.0).clamp(0.0, 100.0),
        resets_at: quota.reset_time.clone(),
        seconds_until_reset,
    }
}

fn bottleneck(values: impl Iterator<Item = QuotaCandidate>) -> Option<QuotaCandidate> {
    values.min_by(|left, right| {
        left.remaining_percent
            .total_cmp(&right.remaining_percent)
            .then_with(|| {
                left.seconds_until_reset
                    .unwrap_or(i64::MAX)
                    .cmp(&right.seconds_until_reset.unwrap_or(i64::MAX))
            })
    })
}

fn usage_window(candidate: QuotaCandidate, window_seconds: u64) -> UsageWindow {
    UsageWindow {
        remaining_percent: candidate.remaining_percent,
        resets_at: candidate.resets_at,
        window_seconds,
    }
}

fn parse_snapshot(
    response: UserStatusResponse,
) -> Result<ProviderSnapshot, (&'static str, String)> {
    let status = response.user_status.ok_or_else(|| {
        (
            "signed_out",
            response
                .message
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| "Sign in to Antigravity to view quota.".into()),
        )
    })?;
    let now = Utc::now();
    let quotas: Vec<_> = status
        .cascade_model_config_data
        .as_ref()
        .map(|data| {
            data.client_model_configs
                .iter()
                .filter_map(|config| config.quota_info.as_ref())
                .filter(|quota| quota.remaining_fraction.is_finite())
                .map(|quota| quota_candidate(quota, now))
                .collect()
        })
        .unwrap_or_default();
    let short_window = bottleneck(
        quotas
            .iter()
            .filter(|quota| quota.seconds_until_reset.unwrap_or(0) <= 2 * 86_400)
            .cloned(),
    )
    .map(|quota| usage_window(quota, 5 * 3_600));
    let weekly_window = bottleneck(
        quotas
            .iter()
            .filter(|quota| {
                quota
                    .seconds_until_reset
                    .is_some_and(|seconds| seconds > 2 * 86_400)
            })
            .cloned(),
    )
    .map(|quota| usage_window(quota, 7 * 86_400));
    let plan = status
        .plan_status
        .as_ref()
        .and_then(|plan| plan.plan_info.as_ref())
        .and_then(|info| info.plan_name.clone())
        .or_else(|| status.user_tier.and_then(|tier| tier.name));
    let balance_remaining = status
        .plan_status
        .as_ref()
        .and_then(|plan| plan.available_prompt_credits)
        .filter(|credits| credits.is_finite() && *credits >= 0.0);
    if short_window.is_none() && weekly_window.is_none() && balance_remaining.is_none() {
        return Err((
            "unavailable",
            "Antigravity returned no measurable quota data.".into(),
        ));
    }
    Ok(ProviderSnapshot {
        provider: "antigravity".into(),
        display_name: "ANTIGRAVITY".into(),
        plan,
        short_window,
        weekly_window,
        monthly_window: None,
        reset_credits: None,
        reset_credit_expires_at: Vec::new(),
        balance_remaining,
        balance_unit: balance_remaining.map(|_| "credits".into()),
        rate_limit_snapshot: None,
        updated_at: now.to_rfc3339(),
        status: "ok".into(),
        message: None,
    })
}

pub async fn fetch_snapshot() -> Option<ProviderSnapshot> {
    let server = match discover_server().await {
        Ok(server) => server,
        Err(_) if !is_installed() => return None,
        Err(_) => {
            return Some(ProviderSnapshot::provider_failure(
                "antigravity",
                "ANTIGRAVITY",
                "unavailable",
                "Open Antigravity to view its live quota.",
            ))
        }
    };
    let mut ports = BTreeSet::new();
    if let Some(port) = server.hinted_port {
        ports.insert(port);
    }
    ports.extend(listening_ports(server.pid).await);
    if ports.is_empty() {
        return Some(ProviderSnapshot::provider_failure(
            "antigravity",
            "ANTIGRAVITY",
            "unavailable",
            "Antigravity is running, but its quota service is not ready.",
        ));
    }
    let client = match reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return Some(ProviderSnapshot::provider_failure(
                "antigravity",
                "ANTIGRAVITY",
                "unavailable",
                "Antigravity quota connection could not be initialized.",
            ))
        }
    };
    let mut unauthorized = false;
    for port in ports {
        for protocol in ["https", "http"] {
            match request_status(&client, protocol, port, &server.csrf_token).await {
                Ok(response) => {
                    return Some(
                        parse_snapshot(response).unwrap_or_else(|(status, message)| {
                            ProviderSnapshot::provider_failure(
                                "antigravity",
                                "ANTIGRAVITY",
                                status,
                                &message,
                            )
                        }),
                    )
                }
                Err(reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) => {
                    unauthorized = true;
                }
                Err(_) => {}
            }
        }
    }
    let (status, message) = if unauthorized {
        (
            "signed_out",
            "Antigravity login expired. Sign in again to view quota.",
        )
    } else {
        (
            "unavailable",
            "Antigravity quota is temporarily unavailable.",
        )
    };
    Some(ProviderSnapshot::provider_failure(
        "antigravity",
        "ANTIGRAVITY",
        status,
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_quoted_and_unquoted_server_arguments() {
        let line = r#"server.exe --csrf_token="safe token" --extension_server_port=42100"#;
        let server = server_from_parts(42, line).unwrap();
        assert_eq!(server.csrf_token, "safe token");
        assert_eq!(server.hinted_port, Some(42100));
    }

    #[test]
    fn parses_bottleneck_model_quota_and_plan() {
        let response: UserStatusResponse = serde_json::from_value(serde_json::json!({
            "userStatus": {
                "planStatus": {
                    "availablePromptCredits": 320,
                    "planInfo": {"planName": "Google AI Pro"}
                },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [{
                        "quotaInfo": {
                            "remainingFraction": 0.72,
                            "resetTime": (Utc::now() + chrono::Duration::hours(4)).to_rfc3339()
                        }
                    }, {
                        "quotaInfo": {
                            "remainingFraction": 0.41,
                            "resetTime": (Utc::now() + chrono::Duration::hours(3)).to_rfc3339()
                        }
                    }]
                }
            }
        }))
        .unwrap();
        let snapshot = parse_snapshot(response).unwrap();
        assert_eq!(snapshot.plan.as_deref(), Some("Google AI Pro"));
        assert_eq!(snapshot.balance_remaining, Some(320.0));
        assert_eq!(
            snapshot.short_window.unwrap().remaining_percent.round(),
            41.0
        );
        assert!(snapshot.weekly_window.is_none());
    }

    #[test]
    fn separates_short_and_weekly_quota_windows() {
        let response: UserStatusResponse = serde_json::from_value(serde_json::json!({
            "userStatus": {
                "cascadeModelConfigData": {
                    "clientModelConfigs": [{
                        "quotaInfo": {
                            "remainingFraction": 0.8,
                            "resetTime": (Utc::now() + chrono::Duration::hours(5)).to_rfc3339()
                        }
                    }, {
                        "quotaInfo": {
                            "remainingFraction": 0.6,
                            "resetTime": (Utc::now() + chrono::Duration::days(5)).to_rfc3339()
                        }
                    }]
                }
            }
        }))
        .unwrap();
        let snapshot = parse_snapshot(response).unwrap();
        assert_eq!(
            snapshot.short_window.unwrap().remaining_percent.round(),
            80.0
        );
        assert_eq!(
            snapshot.weekly_window.unwrap().remaining_percent.round(),
            60.0
        );
    }
}

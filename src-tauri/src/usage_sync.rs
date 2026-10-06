//! App-owned collection/sync. Credentials remain in the user's Git/SSH tools.
use crate::{
    codex_project_usage, comfort_sync,
    tokei_usage::{self, TokeiUsage},
    usage_sync_git, usage_sync_snapshot,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;

pub(crate) static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STATE: Mutex<Option<SyncRuntime>> = Mutex::new(None);
static WRITE_ID: AtomicU64 = AtomicU64::new(0);
const SETTINGS: &str = "usage-sync.json";
const RUNTIME: &str = "usage-sync-state.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncSettings {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub device_id: String,
    pub remote: String,
    pub branch: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRuntime {
    pub phase: String,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_collected_at: Option<String>,
    pub last_error: Option<String>,
    pub last_commit: Option<String>,
    pub collector_status: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub settings: Option<SyncSettings>,
    pub imported: bool,
    #[serde(flatten)]
    pub runtime: SyncRuntime,
}
pub(crate) fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && !id.starts_with(['-', '.'])
        && !id.ends_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}
fn valid_remote(remote: &str) -> bool {
    ["git@gitee.com:", "git@github.com:"].iter().any(|prefix| {
        remote
            .strip_prefix(prefix)
            .and_then(|s| s.strip_suffix(".git"))
            .is_some_and(|rest| {
                let pieces: Vec<_> = rest.split('/').collect();
                pieces.len() == 2 && pieces.iter().all(|s| safe_id(s) && s.len() <= 100)
            })
    })
}
// Import credential-free HTTPS identities as SSH without modifying Tokei's config.
fn discovered_remote(remote: &str) -> Option<String> {
    if valid_remote(remote) {
        return Some(remote.to_owned());
    }
    for host in ["gitee.com", "github.com"] {
        if let Some(rest) = remote.strip_prefix(&format!("https://{host}/")) {
            let candidate = format!("git@{host}:{rest}");
            if valid_remote(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}
fn validate(settings: &SyncSettings) -> Result<(), String> {
    if !safe_id(&settings.device_id)
        || !valid_remote(&settings.remote)
        || !safe_id(&settings.branch)
        || settings.branch.contains("..")
        || settings.branch.ends_with(".lock")
        || !(60..=86400).contains(&settings.interval_seconds)
    {
        return Err("invalid_sync_settings".into());
    }
    Ok(())
}
fn safe_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("unsafe_sync_path".into());
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err("unsafe_sync_path".into());
        }
        cursor.push(part);
        if fs::symlink_metadata(&cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("unsafe_sync_path".into());
        }
    }
    Ok(())
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    safe_directory(path)?;
    let parent = path.parent().ok_or("unsafe_sync_path")?;
    fs::create_dir_all(parent).map_err(|_| "sync_storage_unavailable")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "sync_storage_unavailable")?;
    let temporary = parent.join(format!(
        ".usage-sync-{}-{}.tmp",
        std::process::id(),
        WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "sync_storage_unavailable")?;
    let written = file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "sync_storage_unavailable");
    drop(file);
    let result =
        written.and_then(|_| fs::rename(&temporary, path).map_err(|_| "sync_storage_unavailable"));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(str::to_owned)
}
pub(crate) fn settings_at(data: &Path) -> Result<Option<SyncSettings>, String> {
    if let Some(cloud) = crate::cloud_sync::config(data)? {
        return Ok(Some(SyncSettings {
            enabled: cloud.enabled,
            interval_seconds: cloud.interval_seconds,
            device_id: cloud.device_id,
            remote: "Cloudflare".into(),
            branch: "cloud".into(),
        }));
    }
    let path = data.join(SETTINGS);
    if !path.try_exists().map_err(|_| "sync_settings_unavailable")? {
        return Ok(None);
    }
    let settings: SyncSettings = serde_json::from_value(tokei_usage::read_json(&path, 32768)?)
        .map_err(|_| "sync_settings_invalid")?;
    validate(&settings)?;
    Ok(Some(settings))
}
fn legacy_directory(home: &Path) -> Option<(PathBuf, String)> {
    let cfg = tokei_usage::read_json(&home.join(".tokei/config.json"), 256 * 1024).ok()?;
    let id = cfg["device_id"].as_str()?.to_owned();
    if !safe_id(&id) {
        return None;
    }
    let dir = cfg["sync_dir"].as_str().unwrap_or("~/.tokei/sync");
    let dir = dir
        .strip_prefix("~/")
        .map_or_else(|| PathBuf::from(dir), |rest| home.join(rest));
    safe_directory(&dir).ok()?;
    Some((dir, id))
}
fn discover(home: &Path) -> Option<SyncSettings> {
    let (dir, id) = legacy_directory(home)?;
    let path = dir.join(".git/config");
    safe_directory(&path).ok()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 32768 {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let mut in_origin = false;
    let mut remote = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
        } else if in_origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    remote = Some(value.trim().to_owned());
                }
            }
        }
    }
    let head = fs::read_to_string(dir.join(".git/HEAD")).ok()?;
    let branch = head.trim().strip_prefix("ref: refs/heads/")?.to_owned();
    let settings = SyncSettings {
        enabled: false,
        interval_seconds: 300,
        device_id: id,
        remote: discovered_remote(&remote?)?,
        branch,
    };
    validate(&settings).ok()?;
    Some(settings)
}
fn runtime(data: &Path) -> SyncRuntime {
    if let Some(state) = STATE.lock().ok().and_then(|s| s.clone()) {
        return state;
    }
    let mut state: SyncRuntime = tokei_usage::read_json(&data.join(RUNTIME), 32768)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if state.phase == "running" {
        state.phase = "interrupted".into();
    }
    state
}
fn record(data: &Path, state: &SyncRuntime) -> Result<(), String> {
    write_json(&data.join(RUNTIME), state)?;
    *STATE.lock().map_err(|_| "sync_state_unavailable")? = Some(state.clone());
    Ok(())
}
pub(crate) fn reset_cloud_runtime(data: &Path) -> Result<(), String> {
    record(
        data,
        &SyncRuntime {
            phase: "idle".into(),
            ..Default::default()
        },
    )
}
fn status(data: &Path, home: &Path) -> Result<SyncStatus, String> {
    let saved = settings_at(data)?;
    let imported = saved.is_none();
    Ok(SyncStatus {
        settings: saved.or_else(|| discover(home)),
        imported,
        runtime: runtime(data),
    })
}
#[tauri::command]
pub fn get_usage_sync_status(app: tauri::AppHandle) -> Result<SyncStatus, String> {
    status(
        &app.path()
            .app_config_dir()
            .map_err(|_| "sync_storage_unavailable")?,
        &dirs::home_dir().ok_or("home_unavailable")?,
    )
}
#[tauri::command]
pub async fn get_codex_project_usage(
    app: tauri::AppHandle,
) -> Result<codex_project_usage::ProjectUsageSnapshot, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let mut result = codex_project_usage::get_codex_project_usage_with_catalog(Some(
        crate::cloud_sync::pricing_path(&data),
    ))
    .await?;
    if let Some(settings) = settings_at(&data)? {
        identify(&mut result, &settings.device_id);
        result.peer_tasks = crate::task_sync::read_peers(&data, &settings.device_id);
    }
    Ok(result)
}
fn synced_comfort_feedback(data: &Path) -> Result<Vec<Value>, String> {
    if settings_at(data)?.is_none() {
        return Ok(Vec::new());
    }
    let mut records =
        comfort_sync::read_synced_feedback(&data.join("usage-sync-repository/cockpit"))?;
    records.extend(comfort_sync::read_synced_feedback(
        &data.join("cloud-snapshots"),
    )?);
    Ok(records)
}
#[tauri::command]
pub fn get_synced_comfort_feedback(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    synced_comfort_feedback(&data)
}
fn identify(result: &mut codex_project_usage::ProjectUsageSnapshot, id: &str) {
    result.device_id = Some(id.to_owned());
    result
        .warnings
        .retain(|w| w != "device_identity_unavailable");
    if result.status == "partial" && result.warnings.is_empty() {
        result.status = "ready".into();
    }
}
#[tauri::command]
pub fn save_usage_sync_settings(
    app: tauri::AppHandle,
    settings: SyncSettings,
) -> Result<SyncStatus, String> {
    let _guard = RUN_LOCK.try_lock().map_err(|_| "sync_busy")?;
    validate(&settings)?;
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    if let Some(old) = settings_at(&data)? {
        if old.device_id != settings.device_id
            || old.remote != settings.remote
            || old.branch != settings.branch
        {
            return Err("sync_identity_locked".into());
        }
    }
    write_json(&data.join(SETTINGS), &settings)?;
    let catalog = data.join("usage-prices.json");
    if !catalog
        .try_exists()
        .map_err(|_| "sync_storage_unavailable")?
    {
        if let Some(pricing) =
            dirs::home_dir().and_then(|home| codex_project_usage::sanitized_legacy_pricing(&home))
        {
            write_json(&catalog, &pricing)?;
        }
    }
    get_usage_sync_status(app)
}
fn read_baselines(data: &Path, home: &Path, settings: &SyncSettings) -> Vec<Value> {
    let mut paths = vec![
        data.join("cloud-snapshots")
            .join(format!("{}.json", settings.device_id)),
        data.join("usage-sync-local.json"),
        data.join("usage-sync-repository/cockpit")
            .join(format!("{}.json", settings.device_id)),
        data.join("usage-sync-repository")
            .join(format!("{}.json", settings.device_id)),
    ];
    if let Some((dir, id)) = legacy_directory(home) {
        if id == settings.device_id {
            paths.push(dir.join(format!("{id}.json")));
        }
    }
    paths
        .into_iter()
        .filter_map(|p| tokei_usage::read_json(&p, 8 * 1024 * 1024).ok())
        .collect()
}
#[tauri::command]
pub async fn sync_usage_now(app: tauri::AppHandle) -> Result<SyncStatus, String> {
    let _guard = RUN_LOCK.try_lock().map_err(|_| "sync_busy")?;
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let home = dirs::home_dir().ok_or("home_unavailable")?;
    let settings = settings_at(&data)?.ok_or("sync_not_configured")?;
    let mut state = runtime(&data);
    state.phase = "running".into();
    state.last_attempt_at = Some(Utc::now().to_rfc3339());
    state.last_error = None;
    record(&data, &state)?;
    let outcome: Result<(String, String, String), String> = async {
        if crate::cloud_sync::config(&data)?.is_some() {
            crate::cloud_sync::pull(&data).await?;
        }
        let mut collected = tokio::time::timeout(
            Duration::from_secs(20),
            codex_project_usage::get_codex_project_usage_with_catalog(Some(
                crate::cloud_sync::pricing_path(&data),
            )),
        )
        .await
        .map_err(|_| "collector_timeout")??;
        identify(&mut collected, &settings.device_id);
        let collected_at = collected.updated_at.clone();
        let collector_status = collected.status.clone();
        state.last_collected_at = Some(collected_at.clone());
        state.collector_status = Some(collector_status.clone());
        if crate::cloud_sync::config(&data)?.is_some() {
            let baselines = read_baselines(&data, &home, &settings);
            let mut payload =
                usage_sync_snapshot::build(&settings.device_id, &collected, &baselines)?;
            payload["_cockpit"]["protocolVersion"] = serde_json::json!(2);
            payload["_cockpit"]["appVersion"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
            payload["_cockpit"]["settingsRevision"] =
                crate::cloud_sync::shared_state(&data)["revision"].clone();
            payload["_cockpit"]["pricingSource"] = serde_json::json!(collected.pricing_source);
            comfort_sync::attach_local_feedback(
                &mut payload,
                &data.join("runtime-state.json"),
                &baselines,
            )?;
            if crate::cloud_sync::config(&data)?.is_some_and(|cfg| cfg.share_task_details) {
                crate::task_sync::attach(&mut payload, &collected);
            }
            write_json(&data.join("usage-sync-local.json"), &payload)?;
            crate::cloud_sync::exchange(&data, payload).await?;
            return Ok(("cloudflare".into(), collected_at, collector_status));
        }
        let data = data.clone();
        let home = home.clone();
        let settings = settings.clone();
        let commit = tauri::async_runtime::spawn_blocking(move || {
            let repo = data.join("usage-sync-repository");
            let prepared = usage_sync_git::prepare_for_device(
                &repo,
                &settings.remote,
                &settings.branch,
                &settings.device_id,
            );
            let baselines = read_baselines(&data, &home, &settings);
            let mut payload =
                usage_sync_snapshot::build(&settings.device_id, &collected, &baselines)?;
            comfort_sync::attach_local_feedback(
                &mut payload,
                &data.join("runtime-state.json"),
                &baselines,
            )?;
            write_json(&data.join("usage-sync-local.json"), &payload)?;
            prepared?;
            crate::shared_settings::attach(&data, &mut payload)?;
            write_json(&data.join("usage-sync-local.json"), &payload)?;
            let bytes = serde_json::to_vec(&payload).map_err(|_| "snapshot_invalid")?;
            let receipt = usage_sync_git::publish(
                &repo,
                &settings.remote,
                &settings.branch,
                &settings.device_id,
                &bytes,
            )?;
            Ok::<String, String>(receipt.commit)
        })
        .await
        .map_err(|_| "sync_worker_failed")??;
        Ok((commit, collected_at, collector_status))
    }
    .await;
    match outcome {
        Ok((commit, collected_at, collector_status)) => {
            state.phase = "idle".into();
            state.last_success_at = Some(Utc::now().to_rfc3339());
            state.last_collected_at = Some(collected_at);
            state.collector_status = Some(collector_status);
            state.last_commit = Some(commit);
            state.last_error = None;
        }
        Err(error) => {
            state.phase = "error".into();
            state.last_error = Some(error);
        }
    }
    record(&data, &state)?;
    status(&data, &home)
}
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_peer_attempt: Option<std::time::Instant> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let Ok(data) = app.path().app_config_dir() else {
                continue;
            };
            if !matches!(crate::cloud_sync::config(&data), Ok(Some(_))) {
                continue;
            }
            let Ok(Some(settings)) = settings_at(&data) else {
                continue;
            };
            if !settings.enabled {
                continue;
            }
            let state = runtime(&data);
            let due = state
                .last_attempt_at
                .as_deref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .is_none_or(|t| {
                    (Utc::now() - t.with_timezone(&Utc)).num_seconds()
                        >= settings.interval_seconds as i64
                });
            if due {
                let _ = sync_usage_now(app.clone()).await;
                last_peer_attempt = Some(std::time::Instant::now());
            } else if last_peer_attempt.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
                // Peer downloads do not require a fresh local collection/upload.
                if let Ok(_guard) = RUN_LOCK.try_lock() {
                    let _ = crate::cloud_sync::pull(&data).await;
                    last_peer_attempt = Some(std::time::Instant::now());
                }
            }
        }
    });
}
pub fn merge_managed_usage(data: &Path, usage: &mut TokeiUsage) {
    let mut paths = vec![data.join("usage-sync-local.json")];
    for dir in [
        data.join("cloud-snapshots"),
        data.join("usage-sync-repository"),
        data.join("usage-sync-repository/cockpit"),
    ] {
        if safe_directory(&dir).is_err() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            paths.extend(
                entries
                    .take(128)
                    .filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "json")),
            );
        }
    }
    let mut bytes = 0;
    for path in paths {
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        bytes += size;
        if bytes > 64 * 1024 * 1024 {
            usage.warnings.push("managed_scan_limit".into());
            break;
        }
        let Ok(value) = tokei_usage::read_json(&path, 8 * 1024 * 1024) else {
            continue;
        };
        let Some(id) = value["_device"].as_str().filter(|s| safe_id(s)) else {
            continue;
        };
        let local = path == data.join("usage-sync-local.json");
        if local {
            if settings_at(data)
                .ok()
                .flatten()
                .is_none_or(|s| s.device_id != id)
            {
                continue;
            }
        } else if path.file_stem().and_then(|s| s.to_str()) != Some(id) {
            continue;
        }
        if value["_ts"]
            .as_i64()
            .is_none_or(|ts| ts <= 0 || ts > Utc::now().timestamp() + 300)
        {
            continue;
        }
        let Some(device) = tokei_usage::parse_device(&value, id, None) else {
            continue;
        };
        if let Some(index) = usage.devices.iter().position(|old| old.id == id) {
            if device.updated_at > usage.devices[index].updated_at {
                usage.devices[index] = device;
            }
        } else {
            usage.devices.push(device);
        }
    }
    if settings_at(data).ok().flatten().is_some() {
        usage
            .warnings
            .retain(|w| w != "config_unavailable" && w != "sync_unavailable");
        if usage.devices.is_empty() {
            usage.status = "unavailable".into();
        } else {
            usage.status = if usage.warnings.is_empty() {
                "ready"
            } else {
                "partial"
            }
            .into();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_credential_free_https_identities_as_ssh() {
        assert_eq!(
            discovered_remote("https://gitee.com/owner/usage.git").as_deref(),
            Some("git@gitee.com:owner/usage.git")
        );
        for remote in [
            "https://token@gitee.com/owner/usage.git",
            "https://gitee.com/owner/usage.git?token=x",
            "https://other.example/owner/usage.git",
            "https://gitee.com/../usage.git",
        ] {
            assert!(discovered_remote(remote).is_none());
        }
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "cockpit-sync-controller-{}-{}",
                std::process::id(),
                WRITE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn refuses_credentials_options_and_unsafe_identity() {
        let mut s = SyncSettings {
            enabled: false,
            interval_seconds: 300,
            device_id: "Mac-mini".into(),
            remote: "git@gitee.com:owner/usage.git".into(),
            branch: "main".into(),
        };
        assert!(validate(&s).is_ok());
        for remote in [
            "https://token@gitee.com/owner/usage.git",
            "file:///tmp/repo",
            "-oProxyCommand=evil",
            "git@gitee.com:../usage.git",
        ] {
            s.remote = remote.into();
            assert!(validate(&s).is_err());
        }
        assert!(!safe_id("../peer"));
        assert!(!safe_id("--upload-pack"));
    }
    #[test]
    fn settings_are_opt_in_and_atomically_replaceable() {
        let f = Fixture::new();
        assert!(settings_at(&f.0).unwrap().is_none());
        let mut s = SyncSettings {
            enabled: false,
            interval_seconds: 300,
            device_id: "Mac".into(),
            remote: "git@gitee.com:owner/usage.git".into(),
            branch: "main".into(),
        };
        write_json(&f.0.join(SETTINGS), &s).unwrap();
        assert!(!settings_at(&f.0).unwrap().unwrap().enabled);
        s.enabled = true;
        write_json(&f.0.join(SETTINGS), &s).unwrap();
        assert_eq!(settings_at(&f.0).unwrap(), Some(s));
    }
    #[test]
    fn cloud_transport_wins_even_when_paused_and_corruption_never_falls_back_to_git() {
        let f = Fixture::new();
        write_json(
            &f.0.join(SETTINGS),
            &SyncSettings {
                enabled: true,
                interval_seconds: 300,
                device_id: "old-mac".into(),
                remote: "git@gitee.com:owner/usage.git".into(),
                branch: "main".into(),
            },
        )
        .unwrap();
        let cloud = serde_json::json!({"endpoint":"https://example.workers.dev","deviceId":"cloud-mac","spaceId":"space-1","spaceName":"Team","role":"owner","enabled":false,"intervalSeconds":300});
        write_json(&f.0.join("cloud-sync.json"), &cloud).unwrap();
        let settings = settings_at(&f.0).unwrap().unwrap();
        assert_eq!(settings.device_id, "cloud-mac");
        assert_eq!(settings.remote, "Cloudflare");
        assert!(!settings.enabled);
        write_json(
            &f.0.join("cloud-sync.json"),
            &serde_json::json!({"deviceId":"../escape"}),
        )
        .unwrap();
        assert!(settings_at(&f.0).is_err());
    }
    #[test]
    fn synced_feedback_is_opt_in_and_reads_only_fetched_cockpit_files() {
        let f = Fixture::new();
        assert!(synced_comfort_feedback(&f.0).unwrap().is_empty());
        assert!(!f.0.join("usage-sync-repository").exists());

        let settings = SyncSettings {
            enabled: false,
            interval_seconds: 300,
            device_id: "Mac".into(),
            remote: "git@gitee.com:owner/usage.git".into(),
            branch: "main".into(),
        };
        write_json(&f.0.join(SETTINGS), &settings).unwrap();
        write_json(
            &f.0.join("usage-sync-local.json"),
            &serde_json::json!({
                "_device":"local-only","_ts":Utc::now().timestamp(),
                "comfortFeedbackVersion":1,"comfortFeedback":[]
            }),
        )
        .unwrap();
        assert!(synced_comfort_feedback(&f.0).unwrap().is_empty());
        assert!(!f.0.join("usage-sync-repository").exists());

        let cockpit = f.0.join("usage-sync-repository/cockpit");
        fs::create_dir_all(&cockpit).unwrap();
        let now = Utc::now();
        write_json(
            &cockpit.join("peer.json"),
            &serde_json::json!({
                "_device":"peer","_ts":now.timestamp(),
                "comfortFeedbackVersion":1,
                "comfortFeedback":[{
                    "localDate":chrono::Local::now().format("%Y-%m-%d").to_string(),
                    "observedAt":now.to_rfc3339(),"updatedAt":now.to_rfc3339(),
                    "comfort":"comfortable","personId":"person-a","personName":"Alice",
                    "tokenSnapshot":null,"quotaAllocation":null,
                    "observedUsedPercent":40.0,"usageObservedAt":now.to_rfc3339(),
                    "usageCoverage":"complete","usageSource":"official-snapshot",
                    "curveVersion":"p014-t014-ordinal-map-v3"
                }]
            }),
        )
        .unwrap();
        let records = synced_comfort_feedback(&f.0).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["personId"], "person-a");
    }
    #[test]
    fn peer_identity_and_future_timestamp_cannot_replace_valid_snapshot() {
        let f = Fixture::new();
        let dir = f.0.join("usage-sync-repository/cockpit");
        fs::create_dir_all(&dir).unwrap();
        let now = Utc::now().timestamp();
        let payload = |id: &str, ts: i64| serde_json::json!({"_device":id,"_ts":ts,"_ledger":{"tools":{"codex":{"2026-09-01":{"in":100,"cached":0,"out":1,"cost":1}}}}});
        write_json(&dir.join("Mac.json"), &payload("Mac", now)).unwrap();
        write_json(&dir.join("Spoof.json"), &payload("Mac", now + 1)).unwrap();
        write_json(&dir.join("Future.json"), &payload("Future", now + 3600)).unwrap();
        let mut usage = TokeiUsage {
            local_group_id: None,
            fetched_at: Utc::now().to_rfc3339(),
            status: "unavailable".into(),
            groups: vec![],
            default_group_id: None,
            devices: vec![],
            warnings: vec![],
            project_breakdown_available: false,
        };
        merge_managed_usage(&f.0, &mut usage);
        assert_eq!(usage.devices.len(), 1);
        assert_eq!(usage.devices[0].id, "Mac");
        assert_eq!(
            usage.devices[0].updated_at.as_deref(),
            Some(
                DateTime::from_timestamp(now, 0)
                    .unwrap()
                    .to_rfc3339()
                    .as_str()
            )
        );
    }
}

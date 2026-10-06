//! Read-only, bounded adapter for Tokei's aggregate Codex snapshots, never sessions.
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DEVICES: usize = 128;
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub id: String,
    pub name: String,
    pub device_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSettings {
    pub groups: Vec<UsageGroup>,
    pub default_group_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ModelUsage {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub metrics: Metrics,
}
#[derive(Clone, Debug, Serialize)]
pub struct UsagePeriod {
    pub start: Option<String>,
    pub end: Option<String>,
    #[serde(flatten)]
    pub metrics: Metrics,
    pub models: Vec<ModelUsage>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsage {
    pub id: String,
    pub updated_at: Option<String>,
    pub stale: bool,
    pub collection_partial: bool,
    pub daily: BTreeMap<String, UsagePeriod>,
    pub ranges: BTreeMap<String, UsagePeriod>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokeiUsage {
    pub local_group_id: Option<String>,
    pub fetched_at: String,
    pub status: String,
    pub groups: Vec<UsageGroup>,
    pub default_group_id: Option<String>,
    pub devices: Vec<DeviceUsage>,
    pub warnings: Vec<String>,
    pub project_breakdown_available: bool,
}

fn safe_text(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 128
        && !s.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn safe_id(s: &str) -> bool {
    safe_text(s) && !s.contains(['/', '\\']) && s != "." && s != ".."
}
fn no_symlinks(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("unsafe_path".into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err("unsafe_path".into());
        }
        current.push(component);
        // A drive/UNC prefix alone is not a filesystem entry. Inspect it only
        // after RootDir has completed the absolute Windows root.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        if fs::symlink_metadata(&current)
            .map_err(|_| "source_unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("unsafe_path".into());
        }
    }
    Ok(())
}
pub(crate) fn read_json(path: &Path, max: u64) -> Result<Value, String> {
    no_symlinks(path)?;
    let file = fs::File::open(path).map_err(|_| "source_unavailable")?;
    let meta = file.metadata().map_err(|_| "source_unavailable")?;
    if !meta.is_file() || meta.len() > max {
        return Err("source_too_large".into());
    }
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "source_unavailable")?;
    if bytes.len() as u64 > max {
        return Err("source_too_large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_snapshot".into())
}
fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "home_unavailable".into())
}
fn config(home: &Path) -> Value {
    read_json(&home.join(".tokei/config.json"), 256 * 1024).unwrap_or(Value::Null)
}
fn imported_groups(config: &Value) -> GroupSettings {
    let mut seen = HashSet::new();
    let mut names = HashSet::new();
    let groups: Vec<_> = config["device_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .take(64)
        .enumerate()
        .filter_map(|(i, g)| {
            let name = g["name"].as_str()?.trim();
            if !safe_text(name) || !names.insert(name.to_owned()) {
                return None;
            }
            let device_ids = g["device_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| safe_id(s) && seen.insert((*s).to_owned()))
                .take(MAX_DEVICES)
                .map(str::to_owned)
                .collect();
            Some(UsageGroup {
                id: format!("group-{}", i + 1),
                name: name.to_owned(),
                device_ids,
            })
        })
        .collect();
    GroupSettings {
        default_group_id: groups.first().map(|g| g.id.clone()),
        groups,
    }
}
pub(crate) fn validate_groups(settings: &GroupSettings) -> Result<(), String> {
    let (mut ids, mut names, mut devices) = (HashSet::new(), HashSet::new(), HashSet::new());
    if settings.groups.len() > 64 {
        return Err("too_many_groups".into());
    }
    for g in &settings.groups {
        if !safe_id(&g.id)
            || !safe_text(&g.name)
            || g.name.trim() != g.name
            || !ids.insert(&g.id)
            || !names.insert(&g.name)
            || g.device_ids.len() > MAX_DEVICES
        {
            return Err("invalid_groups".into());
        }
        for d in &g.device_ids {
            if !safe_id(d) || !devices.insert(d) {
                return Err("duplicate_or_invalid_device".into());
            }
        }
    }
    if settings
        .default_group_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("invalid_default_group".into());
    }
    Ok(())
}
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("usage-groups.json"))
        .map_err(|_| "settings_unavailable".into())
}
fn load_groups(path: &Path, cfg: &Value) -> Result<GroupSettings, String> {
    let mut exists = false;
    for candidate in [path.to_path_buf(), path.with_extension("json.bak")] {
        exists |= fs::symlink_metadata(&candidate).is_ok();
        if let Ok(value) = read_json(&candidate, 256 * 1024) {
            if let Ok(settings) = serde_json::from_value::<GroupSettings>(value) {
                if validate_groups(&settings).is_ok() {
                    return Ok(settings);
                }
            }
        }
    }
    if exists {
        Err("group_settings_corrupt".into())
    } else {
        Ok(imported_groups(cfg))
    }
}
pub(crate) fn local_groups(data: &Path) -> Result<GroupSettings, String> {
    load_groups(&data.join("usage-groups.json"), &config(&home()?))
}
#[tauri::command]
pub fn get_tokei_groups(app: tauri::AppHandle) -> Result<GroupSettings, String> {
    load_groups(&settings_path(&app)?, &config(&home()?))
}
#[tauri::command]
pub async fn save_tokei_groups(
    app: tauri::AppHandle,
    settings: GroupSettings,
    expected: GroupSettings,
) -> Result<GroupSettings, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "settings_unavailable")?;
    if crate::cloud_sync::config(&data)?.is_some() {
        return crate::cloud_sync::save_groups(&data, &settings, &expected).await;
    }
    crate::shared_settings::edit_groups(&data, &settings, &expected)
}
pub(crate) fn save_groups(path: &Path, settings: &GroupSettings) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "settings_unavailable")?;
    validate_groups(settings)?;
    let parent = path.parent().ok_or("settings_unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "settings_unavailable")?;
    no_symlinks(parent)?;
    let tmp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    for target in [path, &path.with_extension("json.bak")] {
        if fs::symlink_metadata(target).is_ok() {
            no_symlinks(target)?;
        }
    }
    // A damaged primary never overwrites a valid recovery copy.
    load_groups(path, &Value::Null)?;
    let result = (|| {
        let bytes = serde_json::to_vec(settings).map_err(|_| "invalid_groups")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| "settings_unavailable")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "settings_unavailable")?;
        if read_json(path, 256 * 1024)
            .ok()
            .and_then(|v| serde_json::from_value::<GroupSettings>(v).ok())
            .is_some_and(|g| validate_groups(&g).is_ok())
        {
            fs::copy(path, path.with_extension("json.bak")).map_err(|_| "settings_unavailable")?;
        }
        fs::rename(&tmp, path).map_err(|_| "settings_unavailable")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(str::to_owned)
}
fn count(v: &Value, key: &str) -> Option<u64> {
    v[key].as_u64().filter(|n| *n <= 9_007_199_254_740_991)
}
fn metrics(v: &Value, ledger: bool, model: bool) -> Option<Metrics> {
    let raw = count(v, "in")?;
    let cached = if model {
        count(v, "cr")
            .unwrap_or(0)
            .checked_add(count(v, "cw").unwrap_or(0))?
    } else {
        count(v, "cached")?
    };
    let input = if ledger {
        raw.checked_sub(cached)?
    } else {
        raw
    };
    let output = count(v, "out")?;
    let total = input.checked_add(cached)?.checked_add(output)?;
    if total > 9_007_199_254_740_991 {
        return None;
    }
    Some(Metrics {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_tokens: count(v, "reason").unwrap_or(0).min(output),
        total_tokens: total,
        estimated_cost_usd: v["cost"].as_f64().filter(|c| c.is_finite() && *c >= 0.0),
    })
}
fn period(
    v: &Value,
    ledger: bool,
    start: Option<String>,
    end: Option<String>,
) -> Option<UsagePeriod> {
    let mut models = Vec::new();
    let pairs: Vec<_> = if ledger {
        v["models"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, v)| (k.clone(), v))
            .collect()
    } else {
        v["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                let id = v["model_id"]
                    .as_str()
                    .filter(|id| safe_text(id))
                    .map(str::to_owned)
                    .or_else(|| {
                        v["name"]
                            .as_str()
                            .filter(|name| safe_text(name))
                            .map(|name| format!("tokei-name:{name}"))
                    })?;
                Some((id, v))
            })
            .collect()
    };
    for (id, v) in pairs.into_iter().take(256) {
        if safe_text(&id) {
            if let Some(metrics) = metrics(v, false, true) {
                models.push(ModelUsage {
                    id: id.clone(),
                    name: v["name"]
                        .as_str()
                        .filter(|s| safe_text(s))
                        .unwrap_or(&id)
                        .to_owned(),
                    metrics,
                });
            }
        }
    }
    Some(UsagePeriod {
        start,
        end,
        metrics: metrics(v, ledger, false)?,
        models,
    })
}
fn date(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .filter(|d| d.to_string() == s)
        .map(|_| s.to_owned())
}
pub(crate) fn parse_device(
    v: &Value,
    id: &str,
    fallback_time: Option<DateTime<Utc>>,
) -> Option<DeviceUsage> {
    if !safe_id(id) {
        return None;
    }
    let updated = v["_ts"]
        .as_i64()
        .and_then(|ts| DateTime::from_timestamp(ts, 0))
        .or(fallback_time);
    let now = Utc::now();
    let stale = updated
        .is_none_or(|t| (now - t).num_seconds() > 900 || t > now + chrono::Duration::minutes(5));
    let mut daily = BTreeMap::new();
    if let Some(days) = v.pointer("/_ledger/tools/codex").and_then(Value::as_object) {
        for (key, value) in days.iter().rev().take(3660) {
            if let Some(day) = date(&Value::String(key.clone())) {
                if let Some(p) = period(value, true, Some(day.clone()), None) {
                    daily.insert(day, p);
                }
            }
        }
    }
    let mut ranges = BTreeMap::new();
    for key in [
        "today",
        "yesterday",
        "week",
        "last_week",
        "month",
        "year",
        "all",
    ] {
        // A malformed explicit bound must not become an unbounded all-time range.
        let bounds = &v["_range_bounds"][key];
        if ["start", "end"]
            .iter()
            .any(|field| !bounds[*field].is_null() && date(&bounds[*field]).is_none())
        {
            continue;
        }
        if let Some(p) = period(
            &v["codex"]["ranges"][key],
            false,
            date(&v["_range_bounds"][key]["start"]),
            date(&v["_range_bounds"][key]["end"]),
        ) {
            ranges.insert(key.into(), p);
        }
    }
    if daily.is_empty() && ranges.is_empty() {
        return None;
    }
    Some(DeviceUsage {
        id: id.into(),
        updated_at: updated.map(|t| t.to_rfc3339()),
        stale,
        collection_partial: v["_cockpit"].is_object()
            && v["_cockpit"]["status"].as_str() != Some("ready"),
        daily,
        ranges,
    })
}
fn load_usage(home: &Path, settings: GroupSettings) -> TokeiUsage {
    let cfg = config(home);
    let mut warnings = Vec::new();
    if cfg.is_null() {
        warnings.push("config_unavailable".into());
    }
    let mut devices = BTreeMap::new();
    let mut scan_bytes = 0_u64;
    let sync = cfg["sync_dir"]
        .as_str()
        .map(|s| {
            if let Some(rest) = s.strip_prefix("~/") {
                home.join(rest)
            } else {
                PathBuf::from(s)
            }
        })
        .unwrap_or_else(|| home.join(".tokei/sync"));
    if sync.is_absolute() && no_symlinks(&sync).is_ok() {
        if let Ok(entries) = fs::read_dir(&sync) {
            for (index, entry) in entries.take(MAX_DEVICES + 1).enumerate() {
                if index >= MAX_DEVICES {
                    warnings.push("device_limit".into());
                    break;
                }
                let Ok(entry) = entry else {
                    warnings.push("snapshot_unavailable".into());
                    continue;
                };
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "json") {
                    continue;
                }
                let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if !safe_id(id) {
                    continue;
                }
                let size = fs::symlink_metadata(&path)
                    .map(|m| m.len())
                    .unwrap_or(MAX_BYTES + 1);
                scan_bytes = scan_bytes.saturating_add(size);
                if scan_bytes > MAX_SCAN_BYTES {
                    warnings.push("scan_limit".into());
                    break;
                }
                match read_json(&path, MAX_BYTES) {
                    Ok(v) if v["_device"].as_str() == Some(id) => {
                        if let Some(device) = parse_device(&v, id, None) {
                            devices.insert(id.to_owned(), device);
                        } else {
                            warnings.push("codex_data_unavailable".into());
                        }
                    }
                    _ => warnings.push("snapshot_unavailable".into()),
                }
            }
        } else {
            warnings.push("sync_unavailable".into());
        }
    } else {
        warnings.push("sync_unavailable".into());
    }
    if let Some(id) = cfg["device_id"].as_str().filter(|s| safe_id(s)) {
        if !devices.contains_key(id) {
            let path = home.join(".tokei/last_usage.json");
            if let Ok(v) = read_json(&path, MAX_BYTES) {
                let modified = fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(DateTime::<Utc>::from);
                if let Some(device) = parse_device(&v, id, modified) {
                    devices.insert(id.to_owned(), device);
                    warnings.push("local_range_dates_unknown".into());
                }
            }
        }
    }
    warnings.sort();
    warnings.dedup();
    let status = if devices.is_empty() {
        "unavailable"
    } else if !warnings.is_empty() || devices.values().any(|d| d.stale) {
        "partial"
    } else {
        "ready"
    };
    TokeiUsage {
        local_group_id: None,
        fetched_at: Utc::now().to_rfc3339(),
        status: status.into(),
        groups: settings.groups,
        default_group_id: settings.default_group_id,
        devices: devices.into_values().collect(),
        warnings,
        project_breakdown_available: false,
    }
}
#[tauri::command]
pub async fn get_tokei_usage(app: tauri::AppHandle) -> Result<TokeiUsage, String> {
    let home = home()?;
    let settings = load_groups(&settings_path(&app)?, &config(&home))?;
    let data_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "settings_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut usage = load_usage(&home, settings);
        crate::usage_sync::merge_managed_usage(&data_dir, &mut usage);
        let device_id = crate::usage_sync::settings_at(&data_dir)
            .ok()
            .flatten()
            .map(|settings| settings.device_id)
            .or_else(|| config(&home)["device_id"].as_str().map(str::to_owned));
        usage.local_group_id = local_group_id(&usage.groups, device_id.as_deref());
        usage
    })
    .await
    .map_err(|_| "source_unavailable".into())
}

fn local_group_id(groups: &[UsageGroup], device_id: Option<&str>) -> Option<String> {
    let device_id = device_id?;
    groups
        .iter()
        .find(|group| group.device_ids.iter().any(|id| id == device_id))
        .map(|group| group.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn default_person_follows_this_device_not_shared_default() {
        let groups = vec![
            UsageGroup {
                id: "a".into(),
                name: "A".into(),
                device_ids: vec!["mac".into()],
            },
            UsageGroup {
                id: "b".into(),
                name: "B".into(),
                device_ids: vec!["windows".into()],
            },
        ];
        assert_eq!(local_group_id(&groups, Some("mac")), Some("a".into()));
        assert_eq!(local_group_id(&groups, Some("windows")), Some("b".into()));
        assert_eq!(local_group_id(&groups, Some("unassigned")), None);
        assert_eq!(local_group_id(&groups, None), None);
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "cockpit-usage-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn groups_persist_crud_and_recover_without_reimport() {
        let f = Fixture::new();
        let path = f.0.join("usage-groups.json");
        let cfg = json!({"device_groups":[{"name":"Imported","device_ids":["device"]}]});
        let mut settings = load_groups(&path, &cfg).unwrap();
        settings.groups[0].name = "Custom".into();
        save_groups(&path, &settings).unwrap();
        assert_eq!(
            load_groups(&path, &Value::Null).unwrap().groups[0].name,
            "Custom"
        );
        settings.groups.clear();
        settings.default_group_id = None;
        save_groups(&path, &settings).unwrap();
        assert!(load_groups(&path, &cfg).unwrap().groups.is_empty());
        fs::write(&path, b"invalid").unwrap();
        assert_eq!(load_groups(&path, &cfg).unwrap().groups[0].name, "Custom");
        fs::write(path.with_extension("json.bak"), b"invalid").unwrap();
        assert_eq!(
            load_groups(&path, &cfg).unwrap_err(),
            "group_settings_corrupt"
        );
        assert!(save_groups(&path, &settings).is_err());
    }
    #[test]
    fn missing_bounded_malformed_files_fail_closed() {
        let f = Fixture::new();
        let path = f.0.join("snapshot.json");
        assert!(read_json(&path, 8).is_err());
        fs::write(&path, b"{\"abcdef\":1}").unwrap();
        assert_eq!(read_json(&path, 8).unwrap_err(), "source_too_large");
        fs::write(&path, b"{").unwrap();
        assert_eq!(read_json(&path, 8).unwrap_err(), "invalid_snapshot");
        let result = load_usage(&f.0, imported_groups(&Value::Null));
        assert_eq!(result.status, "unavailable");
        assert!(result.warnings.contains(&"config_unavailable".to_owned()));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_source_and_settings_rejected() {
        let f = Fixture::new();
        let real = f.0.join("real.json");
        let link = f.0.join("usage-groups.json");
        fs::write(&real, b"{}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read_json(&link, 100).unwrap_err(), "unsafe_path");
        assert!(save_groups(&link, &imported_groups(&Value::Null)).is_err());
        assert_eq!(fs::read(&real).unwrap(), b"{}");
    }
    #[test]
    fn synced_local_device_is_not_counted_twice_and_null_time_stays_unknown() {
        let f = Fixture::new();
        let tokei = f.0.join(".tokei");
        fs::create_dir_all(tokei.join("sync")).unwrap();
        fs::write(
            tokei.join("config.json"),
            serde_json::to_vec(&json!({"device_id":"test"})).unwrap(),
        )
        .unwrap();
        let snapshot = json!({"_device":"test","_ts":null,"codex":{"ranges":{"today":{"in":20,"cached":80,"out":10}}}});
        fs::write(
            tokei.join("sync/test.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        fs::write(
            tokei.join("last_usage.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        let result = load_usage(&f.0, imported_groups(&Value::Null));
        assert_eq!(result.devices.len(), 1);
        assert!(result.devices[0].updated_at.is_none());
        assert!(result.devices[0].stale);
        let fallback = parse_device(&snapshot, "test", Some(Utc::now())).unwrap();
        assert!(fallback.updated_at.is_some());
        assert!(!fallback.stale);
    }
    #[test]
    fn ledger_and_range_accounting_agree() {
        let a = metrics(
            &json!({"in":100,"cached":80,"out":10,"reason":5}),
            true,
            false,
        )
        .unwrap();
        let b = metrics(
            &json!({"in":20,"cached":80,"out":10,"reason":5}),
            false,
            false,
        )
        .unwrap();
        assert_eq!(a.total_tokens, 110);
        assert_eq!(a.input_tokens, b.input_tokens);
        assert_eq!(a.estimated_cost_usd, None);
        assert!(metrics(&json!({"in":5,"cached":80,"out":10}), true, false).is_none());
    }
    #[test]
    fn only_codex_aggregate_fields_escape() {
        let v = json!({"_ts":1,"auth":"SECRET","_dashboard":{"wrapped":{"projects":["SECRET"]}},"claude":{"ranges":{"today":{"in":999}}},"_ledger":{"tools":{"codex":{"2026-09-10":{"in":100,"cached":80,"out":10,"models":{"test-model":{"in":20,"cr":80,"cw":0,"out":10}}}},"claude":{"2026-09-10":{"in":999}}}}});
        let d = parse_device(&v, "test-device", None).unwrap();
        let serialized = serde_json::to_string(&d).unwrap();
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("claude"));
        assert_eq!(d.daily.len(), 1);
        assert_eq!(d.daily["2026-09-10"].models[0].metrics.total_tokens, 110);
        assert!(d.stale);
    }
    #[test]
    fn name_only_range_models_are_preserved_without_guessing_variants() {
        let v = json!({"_ts":1,"_range_bounds":{"month":{"start":"2026-09-01","end":"2026-10-01"}},"codex":{"ranges":{"month":{"in":20,"cached":80,"out":10,"cost":1.5,"models":[{"name":"GPT-6","in":20,"cr":80,"cw":0,"out":10,"cost":1.5}]}}}});
        let device = parse_device(&v, "fixture", None).unwrap();
        assert!(device.daily.is_empty());
        let range = &device.ranges["month"];
        assert_eq!(range.metrics.total_tokens, 110);
        assert_eq!(range.metrics.estimated_cost_usd, Some(1.5));
        assert_eq!(range.models[0].id, "tokei-name:GPT-6");
        assert_eq!(range.models[0].name, "GPT-6");
        assert_eq!(range.models[0].metrics.total_tokens, 110);
    }
    #[test]
    fn canonical_model_ids_win_and_malformed_all_bounds_are_rejected() {
        let value = json!({"in":20,"cached":80,"out":10,"models":[{"model_id":"openai/gpt-6-astra","name":"GPT-6","in":20,"cr":80,"out":10}]});
        let range = period(&value, false, None, None).unwrap();
        assert_eq!(range.models[0].id, "openai/gpt-6-astra");
        let v = json!({"codex":{"ranges":{"all":value}},"_range_bounds":{"all":{"start":"bad-date","end":null}}});
        assert!(parse_device(&v, "fixture", None).is_none());
    }
    #[test]
    fn exclusive_groups_and_safe_ids() {
        let mut settings = imported_groups(
            &json!({"device_groups":[{"name":"A","device_ids":["device"]},{"name":"B","device_ids":["device"]}]}),
        );
        assert!(settings.groups[1].device_ids.is_empty());
        settings.groups[1].device_ids.push("device".into());
        assert!(validate_groups(&settings).is_err());
        assert!(!safe_id("../auth"));
        assert!(!safe_text("bad\nname"));
    }
    #[test]
    fn malformed_and_cross_provider_only_unavailable() {
        assert!(parse_device(
            &json!({"_dashboard":{"wrapped":{"total_tokens":999}}}),
            "device",
            None
        )
        .is_none());
        assert!(date(&json!("2026-02-30")).is_none());
    }
    #[test]
    #[ignore = "reads local aggregate snapshots only; prints no data"]
    fn local_read_only_smoke() {
        let h = home().unwrap();
        let result = load_usage(&h, imported_groups(&config(&h)));
        assert!(!result.devices.is_empty());
        assert!(!result.project_breakdown_available);
    }
}

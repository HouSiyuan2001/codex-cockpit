//! Local-only source selection and stable identity. No credentials or chat contents are stored.
use crate::{tokei_usage, usage_sync};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::RandomState,
    fs,
    hash::{BuildHasher, Hasher},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const CONFIG: &str = "local-usage.json";
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static SELECTED_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalConfig {
    device_id: String,
    codex_directory: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSourceStatus {
    pub device_id: String,
    /// Displayed only in this app, never included in a sync payload.
    pub directory: PathBuf,
    pub selection: &'static str,
    pub state: &'static str,
}

fn safe_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return false;
        }
        cursor.push(part);
        if fs::symlink_metadata(&cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    true
}

fn load(data: &Path) -> Result<Option<LocalConfig>, String> {
    let path = data.join(CONFIG);
    if !path
        .try_exists()
        .map_err(|_| "local_settings_unavailable")?
    {
        return Ok(None);
    }
    let config: LocalConfig = serde_json::from_value(tokei_usage::read_json(&path, 16384)?)
        .map_err(|_| "local_settings_invalid")?;
    if !usage_sync::safe_id(&config.device_id)
        || config
            .codex_directory
            .as_deref()
            .is_some_and(|p| !safe_path(p))
    {
        return Err("local_settings_invalid".into());
    }
    Ok(Some(config))
}

fn load_or_create(data: &Path, home: &Path) -> Result<LocalConfig, String> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| "local_settings_unavailable")?;
    if let Some(config) = load(data)? {
        return Ok(config);
    }
    let legacy = tokei_usage::read_json(&home.join(".tokei/config.json"), 256 * 1024).ok();
    let id = usage_sync::settings_at(data)
        .ok()
        .flatten()
        .map(|s| s.device_id)
        .or_else(|| {
            legacy
                .as_ref()?
                .get("device_id")?
                .as_str()
                .filter(|id| usage_sync::safe_id(id))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            // An opaque device label, not an authentication key or a hostname.
            let a = RandomState::new().build_hasher().finish();
            let b = RandomState::new().build_hasher().finish();
            format!("local-{a:016x}{b:016x}")
        });
    let config = LocalConfig {
        device_id: id,
        codex_directory: None,
    };
    usage_sync::write_json(&data.join(CONFIG), &config)?;
    Ok(config)
}

pub(crate) fn device_id(data: &Path, home: &Path) -> Result<String, String> {
    // Existing shared installations retain their identity and group assignment.
    if let Ok(Some(settings)) = usage_sync::settings_at(data) {
        return Ok(settings.device_id);
    }
    Ok(load_or_create(data, home)?.device_id)
}

pub(crate) fn saved_device_id(data: &Path) -> Result<Option<String>, String> {
    Ok(load(data)?.map(|config| config.device_id))
}

pub(crate) fn selected_root() -> Option<PathBuf> {
    SELECTED_ROOT.lock().ok().and_then(|root| root.clone())
}

pub(crate) fn source_path(data: &Path, home: &Path) -> Result<PathBuf, String> {
    let config = load_or_create(data, home)?;
    Ok(config.codex_directory.unwrap_or_else(|| {
        std::env::var_os("CODEX_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
    }))
}

fn source_state(path: &Path) -> &'static str {
    if !safe_path(path) {
        return "unsafe";
    }
    match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "unreadable",
        Ok(meta) if !meta.is_dir() => "invalid",
        Ok(_) => {
            if fs::read_dir(path).is_ok() {
                "ready"
            } else {
                "unreadable"
            }
        }
    }
}

fn status(data: &Path, home: &Path) -> Result<LocalSourceStatus, String> {
    let config = load_or_create(data, home)?;
    let directory = source_path(data, home)?;
    Ok(LocalSourceStatus {
        device_id: device_id(data, home)?,
        state: source_state(&directory),
        directory,
        selection: if config.codex_directory.is_some() {
            "manual"
        } else {
            "automatic"
        },
    })
}

fn validate_directory(directory: &Path, home: &Path) -> Result<(), String> {
    if !safe_path(directory) || directory.parent().is_none() || directory == home {
        return Err("unsafe_source".into());
    }
    match source_state(directory) {
        "ready" => {}
        "missing" => return Err("codex_directory_missing".into()),
        _ => return Err("source_permission_denied".into()),
    }
    // A chosen home/root or unrelated folder must not trigger a broad file scan.
    let recognized = [
        "sessions",
        "archived_sessions",
        "state_5.sqlite",
        "session_index.jsonl",
        "auth.json",
    ]
    .iter()
    .any(|name| {
        let path = directory.join(name);
        safe_path(&path)
            && fs::metadata(path).is_ok_and(|meta| {
                if name.ends_with("sessions") {
                    meta.is_dir()
                } else {
                    meta.is_file()
                }
            })
    });
    if !recognized {
        return Err("not_codex_directory".into());
    }
    Ok(())
}

fn save_source(
    data: &Path,
    home: &Path,
    directory: Option<PathBuf>,
    confirmed: bool,
) -> Result<LocalSourceStatus, String> {
    if !confirmed {
        return Err("source_read_not_confirmed".into());
    }
    if let Some(path) = &directory {
        validate_directory(path, home)?;
    }
    let mut config = load_or_create(data, home)?;
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| "local_settings_unavailable")?;
    config.codex_directory = directory;
    usage_sync::write_json(&data.join(CONFIG), &config)?;
    drop(_guard);
    status(data, home)
}

pub(crate) fn initialize(data: &Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("home_unavailable")?;
    *SELECTED_ROOT
        .lock()
        .map_err(|_| "local_settings_unavailable")? = load_or_create(data, &home)?.codex_directory;
    let id = device_id(data, &home)?;
    tokei_usage::bootstrap_local_groups(data, &home, &id)?;
    Ok(())
}

#[tauri::command]
pub fn get_local_usage_source(app: tauri::AppHandle) -> Result<LocalSourceStatus, String> {
    status(
        &crate::app_config_dir(&app).map_err(|_| "local_settings_unavailable")?,
        &dirs::home_dir().ok_or("home_unavailable")?,
    )
}

#[tauri::command]
pub fn save_local_usage_source(
    app: tauri::AppHandle,
    directory: Option<PathBuf>,
    confirmed: bool,
) -> Result<LocalSourceStatus, String> {
    let _guard = usage_sync::RUN_LOCK
        .try_lock()
        .map_err(|_| "collector_busy")?;
    let next = save_source(
        &crate::app_config_dir(&app).map_err(|_| "local_settings_unavailable")?,
        &dirs::home_dir().ok_or("home_unavailable")?,
        directory,
        confirmed,
    )?;
    *SELECTED_ROOT
        .lock()
        .map_err(|_| "local_settings_unavailable")? =
        (next.selection == "manual").then(|| next.directory.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "cockpit-local-{:016x}",
                RandomState::new().build_hasher().finish()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn fresh_identity_is_stable_without_cloud_or_legacy_files() {
        let f = Fixture::new();
        let id = device_id(&f.0.join("app"), &f.0).unwrap();
        assert!(id.starts_with("local-"));
        assert_eq!(id, device_id(&f.0.join("app"), &f.0).unwrap());
        assert!(!f.0.join("app/cloud-sync.json").exists());
    }
    #[test]
    fn legacy_identity_is_preserved_and_corrupt_settings_are_not_overwritten() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join(".tokei")).unwrap();
        usage_sync::write_json(
            &f.0.join(".tokei/config.json"),
            &serde_json::json!({"device_id":"Existing-PC"}),
        )
        .unwrap();
        assert_eq!(device_id(&f.0.join("app"), &f.0).unwrap(), "Existing-PC");
        fs::write(f.0.join("app/local-usage.json"), "broken").unwrap();
        assert!(load_or_create(&f.0.join("app"), &f.0).is_err());
        assert_eq!(
            fs::read_to_string(f.0.join("app/local-usage.json")).unwrap(),
            "broken"
        );
    }
    #[test]
    fn choosing_a_directory_requires_consent_and_recognized_metadata() {
        let f = Fixture::new();
        let source = f.0.join("custom-codex");
        fs::create_dir_all(source.join("sessions")).unwrap();
        assert_eq!(
            save_source(&f.0.join("app"), &f.0, Some(source.clone()), false)
                .err()
                .unwrap(),
            "source_read_not_confirmed"
        );
        assert!(!f.0.join("app/local-usage.json").exists());
        assert!(validate_directory(&f.0, &f.0).is_err());
        let saved = save_source(&f.0.join("app"), &f.0, Some(source.clone()), true).unwrap();
        assert_eq!(saved.selection, "manual");
        assert_eq!(saved.directory, source);
        assert_eq!(saved.state, "ready");
        let unrelated = f.0.join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        assert_eq!(
            validate_directory(&unrelated, &f.0).unwrap_err(),
            "not_codex_directory"
        );
    }
    #[test]
    fn missing_and_unreadable_are_not_zero_usage() {
        let f = Fixture::new();
        assert_eq!(source_state(&f.0.join("missing")), "missing");
        fs::write(f.0.join("file"), "").unwrap();
        assert_eq!(source_state(&f.0.join("file")), "invalid");
        assert_eq!(source_state(Path::new("relative")), "unsafe");
    }
    #[cfg(unix)]
    #[test]
    fn selected_directory_rejects_symlinks() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("real/sessions")).unwrap();
        std::os::unix::fs::symlink(f.0.join("real"), f.0.join("link")).unwrap();
        assert_eq!(
            validate_directory(&f.0.join("link"), &f.0).unwrap_err(),
            "unsafe_source"
        );
    }
}

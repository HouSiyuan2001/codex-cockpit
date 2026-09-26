//! Versioned, allowlisted person configuration. Device-local preferences never travel.
use crate::{
    tokei_usage::{self, GroupSettings, UsageGroup},
    usage_sync,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, sync::Mutex};
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());
const FILE: &str = "shared-person-settings.json";
const BOOTSTRAP: &str = "1970-01-01T00:00:00Z";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    updated_at: String,
    value: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Shared {
    version: u32,
    groups: BTreeMap<String, Row>,
    devices: BTreeMap<String, Row>,
    plans: BTreeMap<String, Row>,
}
impl Default for Shared {
    fn default() -> Self {
        Self {
            version: 1,
            groups: BTreeMap::new(),
            devices: BTreeMap::new(),
            plans: BTreeMap::new(),
        }
    }
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        && value != "."
        && value != ".."
}
fn revision(row: &Row) -> Result<i64, String> {
    let time = DateTime::parse_from_rfc3339(&row.updated_at)
        .map_err(|_| "shared_settings_invalid")?
        .timestamp_millis();
    if time < 0 || time > Utc::now().timestamp_millis() + 300_000 {
        return Err("shared_settings_invalid_revision".into());
    }
    Ok(time)
}
fn validate(state: &Shared) -> Result<(), String> {
    if state.version != 1
        || state.groups.len() > 128
        || state.devices.len() > 256
        || state.plans.len() > 8192
    {
        return Err("shared_settings_unsupported_or_oversize".into());
    }
    for (key, row) in &state.groups {
        revision(row)?;
        if !id(key)
            || !(row.value.is_null()
                || row.value.as_str().is_some_and(|name| {
                    !name.trim().is_empty()
                        && name.trim() == name
                        && name.chars().count() <= 64
                        && !name.chars().any(|c| {
                            c.is_control()
                                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                        })
                }))
        {
            return Err("shared_settings_invalid_group".into());
        }
    }
    for (key, row) in &state.devices {
        revision(row)?;
        if !id(key) || !(row.value.is_null() || row.value.as_str().is_some_and(id)) {
            return Err("shared_settings_invalid_device".into());
        }
    }
    for (key, row) in &state.plans {
        revision(row)?;
        let parts: Vec<_> = key.split('/').collect();
        if parts.len() != 3
            || !id(parts[0])
            || NaiveDate::parse_from_str(parts[1], "%Y-%m-%d").is_err()
            || parts[1].len() != 10
        {
            return Err("shared_settings_invalid_plan".into());
        }
        let valid = match parts[2] {
            "dailyBudgetPercent" => row
                .value
                .as_f64()
                .is_some_and(|v| v.is_finite() && (1.0..=100.0).contains(&v)),
            "resetRiskOverridePercent" => {
                row.value.is_null()
                    || row
                        .value
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && (0.0..=100.0).contains(&v))
            }
            _ => false,
        };
        if !valid {
            return Err("shared_settings_invalid_plan".into());
        }
    }
    Ok(())
}
fn merge_rows(
    target: &mut BTreeMap<String, Row>,
    incoming: &BTreeMap<String, Row>,
) -> Result<(), String> {
    for (key, row) in incoming {
        if let Some(old) = target.get(key) {
            let (a, b) = (revision(old)?, revision(row)?);
            if a == b && old.value != row.value {
                return Err("shared_settings_conflict".into());
            }
            if a >= b {
                continue;
            }
        }
        target.insert(key.clone(), row.clone());
    }
    Ok(())
}
fn merge(target: &mut Shared, incoming: &Shared) -> Result<(), String> {
    validate(incoming)?;
    merge_rows(&mut target.groups, &incoming.groups)?;
    merge_rows(&mut target.devices, &incoming.devices)?;
    merge_rows(&mut target.plans, &incoming.plans)?;
    validate(target)
}
fn load(data: &Path) -> Result<Shared, String> {
    let path = data.join(FILE);
    if !path
        .try_exists()
        .map_err(|_| "shared_settings_unavailable")?
    {
        // Bootstrap only explicit existing group mappings, never automatic/default plans.
        let mut state = Shared::default();
        for group in tokei_usage::local_groups(data)?.groups {
            state.groups.insert(
                group.id.clone(),
                Row {
                    updated_at: BOOTSTRAP.into(),
                    value: json!(group.name),
                },
            );
            for device in group.device_ids {
                state.devices.insert(
                    device,
                    Row {
                        updated_at: BOOTSTRAP.into(),
                        value: json!(group.id),
                    },
                );
            }
        }
        validate(&state)?;
        return Ok(state);
    }
    let state: Shared = serde_json::from_value(tokei_usage::read_json(&path, 2 * 1024 * 1024)?)
        .map_err(|_| "shared_settings_invalid")?;
    validate(&state)?;
    Ok(state)
}
fn peers(data: &Path, state: &mut Shared) -> Result<(), String> {
    let cockpit = data.join("usage-sync-repository/cockpit");
    if !cockpit
        .try_exists()
        .map_err(|_| "shared_settings_unavailable")?
    {
        return Ok(());
    }
    let mut bytes = 0;
    for (count, entry) in fs::read_dir(&cockpit)
        .map_err(|_| "shared_settings_unavailable")?
        .enumerate()
    {
        if count >= 128 {
            return Err("shared_settings_oversize".into());
        }
        let path = entry.map_err(|_| "shared_settings_unavailable")?.path();
        if path.extension().and_then(|p| p.to_str()) != Some("json") {
            continue;
        }
        let payload = tokei_usage::read_json(&path, 8 * 1024 * 1024)?;
        bytes += serde_json::to_vec(&payload)
            .map_err(|_| "shared_settings_invalid")?
            .len();
        if bytes > 64 * 1024 * 1024 {
            return Err("shared_settings_oversize".into());
        }
        if payload.get("_device").and_then(Value::as_str)
            != path.file_stem().and_then(|p| p.to_str())
        {
            return Err("shared_settings_identity_mismatch".into());
        }
        if let Some(value) = payload.get("personSettings") {
            if payload
                .get("_ts")
                .and_then(Value::as_i64)
                .is_none_or(|t| t <= 0 || t > Utc::now().timestamp() + 300)
            {
                return Err("shared_settings_invalid_revision".into());
            }
            let other =
                serde_json::from_value(value.clone()).map_err(|_| "shared_settings_invalid")?;
            merge(state, &other)?;
        }
    }
    Ok(())
}
fn project(state: &Shared, old: &GroupSettings) -> Result<GroupSettings, String> {
    let groups: Vec<_> = state
        .groups
        .iter()
        .filter_map(|(id, row)| {
            row.value.as_str().map(|name| UsageGroup {
                id: id.clone(),
                name: name.into(),
                device_ids: state
                    .devices
                    .iter()
                    .filter(|(_, row)| row.value.as_str() == Some(id))
                    .map(|(device, _)| device.clone())
                    .collect(),
            })
        })
        .collect();
    let default_group_id = old
        .default_group_id
        .clone()
        .filter(|id| groups.iter().any(|g| &g.id == id));
    let settings = GroupSettings {
        groups,
        default_group_id,
    };
    tokei_usage::validate_groups(&settings).map_err(|_| "shared_settings_group_conflict")?;
    Ok(settings)
}
fn persist(data: &Path, state: &Shared, groups: &GroupSettings) -> Result<(), String> {
    // Ledger is authoritative; a failed second atomic write is recovered on next reconciliation.
    usage_sync::write_json(&data.join(FILE), state)?;
    tokei_usage::save_groups(&data.join("usage-groups.json"), groups)
}
pub fn attach(data: &Path, payload: &mut Value) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "shared_settings_busy")?;
    let mut state = load(data)?;
    peers(data, &mut state)?;
    let groups = project(&state, &tokei_usage::local_groups(data)?)?;
    persist(data, &state, &groups)?;
    payload.as_object_mut().ok_or("snapshot_invalid")?.insert(
        "personSettings".into(),
        serde_json::to_value(state).map_err(|_| "shared_settings_invalid")?,
    );
    Ok(())
}
fn stamp(previous: Option<&Row>, value: Value) -> Result<Row, String> {
    let millis = Utc::now()
        .timestamp_millis()
        .max(previous.map(revision).transpose()?.unwrap_or(0) + 1);
    Ok(Row {
        updated_at: DateTime::<Utc>::from_timestamp_millis(millis)
            .ok_or("shared_settings_invalid_revision")?
            .to_rfc3339(),
        value,
    })
}
pub fn edit_groups(
    data: &Path,
    settings: &GroupSettings,
    expected: &GroupSettings,
) -> Result<GroupSettings, String> {
    let _guard = LOCK.lock().map_err(|_| "shared_settings_busy")?;
    tokei_usage::validate_groups(settings)?;
    let old = tokei_usage::local_groups(data)?;
    if serde_json::to_value(&old).ok() != serde_json::to_value(expected).ok() {
        return Err("shared_settings_conflict_reload".into());
    }
    let mut state = load(data)?;
    // Do not invent deletions from missing peer/legacy files. Only this explicit editor diff removes.
    for group in &settings.groups {
        if old
            .groups
            .iter()
            .find(|g| g.id == group.id)
            .is_none_or(|g| g.name != group.name)
        {
            let row = stamp(state.groups.get(&group.id), json!(group.name))?;
            state.groups.insert(group.id.clone(), row);
        }
    }
    for group in &old.groups {
        if !settings.groups.iter().any(|g| g.id == group.id) {
            let row = stamp(state.groups.get(&group.id), Value::Null)?;
            state.groups.insert(group.id.clone(), row);
        }
    }
    let mapping = |s: &GroupSettings| {
        s.groups
            .iter()
            .flat_map(|g| g.device_ids.iter().map(move |d| (d.clone(), g.id.clone())))
            .collect::<BTreeMap<_, _>>()
    };
    let (before, after) = (mapping(&old), mapping(settings));
    for device in before.keys().chain(after.keys()) {
        if before.get(device) != after.get(device) {
            let row = stamp(state.devices.get(device), json!(after.get(device)))?;
            state.devices.insert(device.clone(), row);
        }
    }
    validate(&state)?;
    persist(data, &state, settings)?;
    Ok(settings.clone())
}
fn own_person(data: &Path, state: &Shared) -> Result<String, String> {
    let settings = usage_sync::settings_at(data)?.ok_or("sync_not_configured")?;
    let person = state
        .devices
        .get(&settings.device_id)
        .and_then(|r| r.value.as_str())
        .ok_or("shared_settings_person_unassigned")?;
    if !state
        .groups
        .get(person)
        .is_some_and(|r| r.value.is_string())
    {
        return Err("shared_settings_person_unassigned".into());
    }
    Ok(person.into())
}
#[tauri::command]
pub fn save_person_plan(
    app: tauri::AppHandle,
    local_date: String,
    field: String,
    value: Value,
) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "shared_settings_unavailable")?;
    let _guard = LOCK.lock().map_err(|_| "shared_settings_busy")?;
    let mut state = load(&data)?;
    let person = own_person(&data, &state)?;
    let key = format!("{person}/{local_date}/{field}");
    let row = stamp(state.plans.get(&key), value.clone())?;
    state.plans.insert(key, row);
    validate(&state)?;
    usage_sync::write_json(&data.join(FILE), &state)?;
    Ok(value)
}
#[tauri::command]
pub fn get_person_plan(app: tauri::AppHandle, local_date: String) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "shared_settings_unavailable")?;
    if usage_sync::settings_at(&data)?.is_none() {
        return Ok(json!({}));
    }
    let _guard = LOCK.lock().map_err(|_| "shared_settings_busy")?;
    let state = load(&data)?;
    let person = match own_person(&data, &state) {
        Ok(person) => person,
        Err(_) => return Ok(json!({})),
    };
    let mut result = serde_json::Map::new();
    for field in ["dailyBudgetPercent", "resetRiskOverridePercent"] {
        if let Some(row) = state.plans.get(&format!("{person}/{local_date}/{field}")) {
            result.insert(field.into(), row.value.clone());
        }
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "person-settings-{}-{}",
                std::process::id(),
                Utc::now().timestamp_nanos_opt().unwrap()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn bootstrap_never_exports_defaults_and_editor_detects_stale_base() {
        let f = Fixture::new();
        let old = GroupSettings {
            groups: vec![UsageGroup {
                id: "alex".into(),
                name: "成员甲".into(),
                device_ids: vec!["win".into()],
            }],
            default_group_id: Some("alex".into()),
        };
        tokei_usage::save_groups(&f.0.join("usage-groups.json"), &old).unwrap();
        usage_sync::write_json(
            &f.0.join("preferences.json"),
            &json!({"dailyBudgetPercent":14.3,"fontScale":1.5,"token":"never-export"}),
        )
        .unwrap();
        let mut payload = json!({"_device":"win"});
        attach(&f.0, &mut payload).unwrap();
        assert_eq!(payload["personSettings"]["plans"], json!({}));
        assert!(!payload.to_string().contains("never-export"));
        let mut changed = old.clone();
        changed.groups[0].name = "Renamed".into();
        edit_groups(&f.0, &changed, &old).unwrap();
        assert_eq!(
            edit_groups(&f.0, &old, &old).unwrap_err(),
            "shared_settings_conflict_reload"
        );
        assert_eq!(
            tokei_usage::local_groups(&f.0).unwrap().groups[0].name,
            "Renamed"
        );
    }
    #[test]
    fn peer_roundtrip_preserves_local_default_and_same_revision_conflict_keeps_disk() {
        let f = Fixture::new();
        let old = GroupSettings {
            groups: vec![UsageGroup {
                id: "alex".into(),
                name: "成员甲".into(),
                device_ids: vec!["win".into()],
            }],
            default_group_id: Some("alex".into()),
        };
        tokei_usage::save_groups(&f.0.join("usage-groups.json"), &old).unwrap();
        let mut peer = Shared::default();
        peer.groups.insert("blair".into(), row(json!("成员乙"), 0));
        peer.devices.insert("laptop".into(), row(json!("blair"), 0));
        let peer_path = f.0.join("usage-sync-repository/cockpit/peer.json");
        usage_sync::write_json(
            &peer_path,
            &json!({"_device":"peer","_ts":Utc::now().timestamp(),"personSettings":peer}),
        )
        .unwrap();
        let mut payload = json!({"_device":"win"});
        attach(&f.0, &mut payload).unwrap();
        let merged = tokei_usage::local_groups(&f.0).unwrap();
        assert_eq!(merged.groups.len(), 2);
        assert_eq!(merged.default_group_id, old.default_group_id);
        let saved = fs::read(f.0.join(FILE)).unwrap();
        peer.devices.get_mut("laptop").unwrap().value = json!("alex");
        usage_sync::write_json(
            &peer_path,
            &json!({"_device":"peer","_ts":Utc::now().timestamp(),"personSettings":peer}),
        )
        .unwrap();
        assert_eq!(
            attach(&f.0, &mut payload).unwrap_err(),
            "shared_settings_conflict"
        );
        assert_eq!(fs::read(f.0.join(FILE)).unwrap(), saved);
    }
    fn row(value: Value, offset: i64) -> Row {
        Row {
            updated_at: DateTime::<Utc>::from_timestamp(1_700_000_000 + offset, 0)
                .unwrap()
                .to_rfc3339(),
            value,
        }
    }
    #[test]
    fn disjoint_devices_union_and_tombstones_do_not_resurrect() {
        let mut a = Shared::default();
        a.groups.insert("alex".into(), row(json!("成员甲"), 0));
        a.devices.insert("win".into(), row(json!("alex"), 0));
        let mut b = a.clone();
        b.devices.insert("mac".into(), row(json!("alex"), 0));
        merge(&mut a, &b).unwrap();
        assert_eq!(a.devices.len(), 2);
        a.devices.insert("win".into(), row(Value::Null, 1));
        merge(&mut a, &b).unwrap();
        assert!(a.devices["win"].value.is_null());
        let empty = GroupSettings {
            groups: vec![],
            default_group_id: None,
        };
        assert_eq!(project(&a, &empty).unwrap().groups[0].device_ids, ["mac"]);
    }
    #[test]
    fn equal_revision_conflict_and_future_revision_fail_closed() {
        let mut a = Shared::default();
        a.devices.insert("win".into(), row(json!("alex"), 0));
        let mut b = a.clone();
        b.devices.get_mut("win").unwrap().value = json!("blair");
        assert_eq!(merge(&mut a, &b).unwrap_err(), "shared_settings_conflict");
        b.devices.get_mut("win").unwrap().updated_at = "2999-01-01T00:00:00Z".into();
        assert!(validate(&b).is_err());
    }
    #[test]
    fn plans_are_person_day_and_field_scoped_and_privacy_allowlisted() {
        let mut a = Shared::default();
        a.plans.insert(
            "alex/2026-09-11/dailyBudgetPercent".into(),
            row(json!(25), 0),
        );
        let mut b = Shared::default();
        b.plans.insert(
            "blair/2026-09-11/dailyBudgetPercent".into(),
            row(json!(10), 0),
        );
        b.plans.insert(
            "alex/2026-09-11/resetRiskOverridePercent".into(),
            row(Value::Null, 0),
        );
        merge(&mut a, &b).unwrap();
        assert_eq!(a.plans.len(), 3);
        a.plans
            .insert("alex/2026-09-11/auth".into(), row(json!("private"), 0));
        assert!(validate(&a).is_err());
        assert!(serde_json::from_value::<Shared>(json!({"version":1,"groups":{},"devices":{},"plans":{},"preferences":{"token":"private"}})).is_err());
    }
}

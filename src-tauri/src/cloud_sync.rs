//! Cloud transport. Member credentials remain in the OS credential store.
use crate::{codex_project_usage, tokei_usage, usage_sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::Manager;

const SERVICE: &str = "app.codexcockpit.desktop.cloud-sync";
const CONFIG: &str = "cloud-sync.json";

fn normalize_endpoint(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "cloud_endpoint_invalid")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("cloud_endpoint_invalid".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn credential_key(endpoint: &str, device: &str) -> String {
    format!("{:x}:{device}", Sha256::digest(endpoint.as_bytes()))
}

pub fn pricing_path(data: &Path) -> std::path::PathBuf {
    if data.join("cloud-pricing.json").exists() && data.join(CONFIG).exists() {
        data.join("cloud-pricing.json")
    } else {
        data.join("usage-prices.json")
    }
}

pub(crate) fn shared_state(data: &Path) -> Value {
    tokei_usage::read_json(&data.join("cloud-shared-settings.json"), 1024 * 1024)
        .unwrap_or(json!({"revision":0,"value":null}))
}

fn apply_shared(data: &Path, shared: &Value) -> Result<(), String> {
    if shared["value"].is_null() {
        return Ok(());
    }
    let revision = shared["revision"]
        .as_u64()
        .ok_or("cloud_settings_invalid")?;
    if shared["value"]["schemaVersion"] != 2 || shared["value"]["costPolicy"] != "event-context-v1"
    {
        return Err("cloud_upgrade_required".into());
    }
    let old = shared_state(data);
    if old["revision"].as_u64().unwrap_or(0) > revision {
        return Err("cloud_settings_stale".into());
    }
    let pricing = codex_project_usage::validate_shared_pricing(&shared["value"]["pricing"])?;
    let groups: tokei_usage::GroupSettings =
        serde_json::from_value(shared["value"]["groups"].clone())
            .map_err(|_| "cloud_groups_invalid")?;
    tokei_usage::validate_groups(&groups)?;
    if tokei_usage::read_json(&data.join("cloud-pricing.json"), 1024 * 1024)
        .ok()
        .as_ref()
        != Some(&pricing)
    {
        usage_sync::write_json(&data.join("cloud-pricing.json"), &pricing)?;
    }
    if tokei_usage::read_json(&data.join("usage-groups.json"), 65536)
        .ok()
        .as_ref()
        != Some(&shared["value"]["groups"])
    {
        tokei_usage::save_groups(&data.join("usage-groups.json"), &groups)?;
    }
    usage_sync::write_json(&data.join("cloud-shared-settings.json"), shared)
}

fn settings_equal(left: &Value, right: &Value) -> bool {
    // JS serializes integral rates as 2 while Rust emits 2.0. Normalize both
    // through the typed catalog so transport formatting cannot bump revisions.
    let normalize = |value: &Value| -> Option<Value> {
        let mut value = value.clone();
        let pricing = codex_project_usage::validate_shared_pricing(&value["pricing"]).ok()?;
        value["pricing"] = pricing;
        Some(value)
    };
    matches!((normalize(left), normalize(right)), (Some(a), Some(b)) if a == b)
}

fn owner_settings_value(current: &Value, local_groups: Value, pricing: Value) -> Value {
    // Only pricing is owner-managed after initialization. Group edits from any
    // member remain authoritative even when the owner refreshes its catalog.
    let groups = if current["value"].is_null() {
        local_groups
    } else {
        current["value"]["groups"].clone()
    };
    json!({"schemaVersion":2,"groups":groups,"pricing":pricing,"costPolicy":"event-context-v1"})
}

async fn synchronize_settings(data: &Path, cfg: &CloudConfig, token: &str) -> Result<(), String> {
    let remote = request(&cfg.endpoint, "/v2/settings", Some(token), None).await?;
    let current = &remote["sharedSettings"];
    if cfg.role == "owner" {
        let home = dirs::home_dir().ok_or("home_unavailable")?;
        let pricing =
            codex_project_usage::shared_pricing_export(&home, &data.join("usage-prices.json"))
                .ok_or("cloud_pricing_missing")?;
        let groups = tokei_usage::read_json(&data.join("usage-groups.json"), 65536)
            .unwrap_or(json!({"groups":[],"defaultGroupId":null}));
        let value = owner_settings_value(current, groups, pricing);
        if !settings_equal(&current["value"], &value) {
            let updated = request(
                &cfg.endpoint,
                "/v2/settings",
                Some(token),
                Some(json!({"expectedRevision":current["revision"],"value":value})),
            )
            .await?;
            apply_shared(data, &updated["sharedSettings"])?;
        } else {
            apply_shared(data, current)?;
        }
    } else {
        apply_shared(data, current)?;
    }
    Ok(())
}

pub async fn save_groups(
    data: &Path,
    settings: &tokei_usage::GroupSettings,
    expected: &tokei_usage::GroupSettings,
) -> Result<tokei_usage::GroupSettings, String> {
    tokei_usage::validate_groups(settings)?;
    let _guard = usage_sync::RUN_LOCK.lock().await;
    let cfg = config(data)?.ok_or("cloud_not_connected")?;
    let token = entry(&cfg.endpoint, &cfg.device_id)?
        .get_password()
        .map_err(|_| "cloud_keychain_unavailable")?;
    let remote = request(&cfg.endpoint, "/v2/settings", Some(&token), None).await?;
    let current = &remote["sharedSettings"];
    if current["value"].is_null() {
        return Err("cloud_settings_unavailable".into());
    }
    let latest: tokei_usage::GroupSettings =
        serde_json::from_value(current["value"]["groups"].clone())
            .map_err(|_| "cloud_groups_invalid")?;
    if &latest != expected {
        apply_shared(data, current)?;
        return Err("cloud_groups_conflict_reload".into());
    }
    let updated = request(
        &cfg.endpoint,
        "/v2/groups",
        Some(&token),
        Some(json!({"expectedRevision":current["revision"],"groups":settings})),
    )
    .await;
    let updated = match updated {
        Ok(value) => value,
        Err(error) if error == "cloud_groups_conflict_reload" => {
            let latest = request(&cfg.endpoint, "/v2/settings", Some(&token), None).await?;
            apply_shared(data, &latest["sharedSettings"])?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    apply_shared(data, &updated["sharedSettings"])?;
    Ok(settings.clone())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConfig {
    pub endpoint: String,
    #[serde(default)]
    pub share_task_details: bool,
    pub device_id: String,
    pub space_id: String,
    pub space_name: String,
    pub role: String,
    pub enabled: bool,
    pub interval_seconds: u64,
}

pub fn config(data: &Path) -> Result<Option<CloudConfig>, String> {
    if !data.join(CONFIG).exists() {
        return Ok(None);
    }
    let value = tokei_usage::read_json(&data.join(CONFIG), 32768)?;
    let cfg: CloudConfig = serde_json::from_value(value).map_err(|_| "cloud_settings_invalid")?;
    if normalize_endpoint(&cfg.endpoint).as_deref() != Ok(cfg.endpoint.as_str())
        || !usage_sync::safe_id(&cfg.device_id)
        || !usage_sync::safe_id(&cfg.space_id)
        || !(60..=86400).contains(&cfg.interval_seconds)
    {
        return Err("cloud_settings_invalid".into());
    }
    Ok(Some(cfg))
}

#[tauri::command]
pub async fn exchange_daily_plan(app: tauri::AppHandle, body: Value) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let cfg = config(&data)?
        .filter(|cfg| cfg.enabled)
        .ok_or("cloud_not_connected")?;
    if body.get("spaceId").and_then(Value::as_str) != Some(cfg.space_id.as_str()) {
        return Err("cloud_plan_scope_changed".into());
    }
    let device = cfg.device_id.clone();
    let endpoint = cfg.endpoint.clone();
    // Credential UI must not block an async runtime thread.
    let token = tauri::async_runtime::spawn_blocking(move || {
        entry(&endpoint, &device)?
            .get_password()
            .map_err(|_| "cloud_keychain_unavailable".to_string())
    })
    .await
    .map_err(|_| "cloud_keychain_unavailable")??;
    request(&cfg.endpoint, "/v2/daily-plan", Some(&token), Some(body)).await
}

fn entry(endpoint: &str, device: &str) -> Result<keyring::Entry, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err("cloud_secure_store_unsupported".into());
    }
    keyring::Entry::new(SERVICE, &credential_key(endpoint, device))
        .map_err(|_| "cloud_keychain_unavailable".into())
}

async fn request(
    endpoint: &str,
    route: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    request_with_bootstrap(endpoint, route, token, body, None).await
}

async fn request_with_bootstrap(
    endpoint: &str,
    route: &str,
    token: Option<&str>,
    body: Option<Value>,
    bootstrap: Option<&str>,
) -> Result<Value, String> {
    let endpoint = normalize_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "cloud_network_error")?;
    let mut request = if let Some(body) = body {
        client.post(format!("{endpoint}{route}")).json(&body)
    } else {
        client.get(format!("{endpoint}{route}"))
    };
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(secret) = bootstrap {
        request = request.header("x-bootstrap-secret", secret);
    }
    let mut response = request.send().await.map_err(|_| "cloud_network_error")?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "cloud_access_denied",
            409 if route == "/v2/settings" => "cloud_settings_conflict",
            409 if route == "/v2/groups" => "cloud_groups_conflict_reload",
            409 if route == "/v2/daily-plan" => "cloud_plan_conflict",
            409 => "cloud_join_conflict",
            413 => "cloud_snapshot_too_large",
            429 => "cloud_rate_limited",
            503 => "cloud_service_unavailable",
            _ => "cloud_request_failed",
        }
        .into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "cloud_network_error")? {
        if bytes.len() + chunk.len() > 40 * 1024 * 1024 {
            return Err("cloud_response_too_large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "cloud_response_invalid")?;
    if value["ok"] != true {
        return Err("cloud_response_invalid".into());
    }
    Ok(value)
}

fn verify_device(data: &Path, device: &str) -> Result<(), String> {
    if !usage_sync::safe_id(device) {
        return Err("cloud_device_required".into());
    }
    let legacy = data.join("usage-sync.json");
    if legacy.exists() {
        let saved = tokei_usage::read_json(&legacy, 32768)?;
        if saved["deviceId"].as_str() != Some(device) {
            return Err("cloud_identity_mismatch".into());
        }
    }
    Ok(())
}

async fn enroll(
    data: &Path,
    endpoint: &str,
    token: String,
    expected_device: Option<&str>,
) -> Result<(), String> {
    let me = request(endpoint, "/v1/me", Some(&token), None).await?;
    let device = me["deviceId"]
        .as_str()
        .filter(|s| usage_sync::safe_id(s))
        .ok_or("cloud_response_invalid")?;
    if expected_device.is_some_and(|expected| expected != device) {
        return Err("cloud_identity_mismatch".into());
    }
    verify_device(data, device)?;
    let space = me["space"]["id"]
        .as_str()
        .filter(|s| usage_sync::safe_id(s))
        .ok_or("cloud_response_invalid")?;
    if config(data)?.is_some_and(|old| {
        old.device_id != device || old.space_id != space || old.endpoint != endpoint
    }) {
        return Err("cloud_identity_locked".into());
    }
    let cfg = CloudConfig {
        endpoint: endpoint.to_owned(),
        share_task_details: false,
        device_id: device.into(),
        space_id: space.into(),
        space_name: me["space"]["name"].as_str().unwrap_or("Cloudflare").into(),
        role: me["role"].as_str().unwrap_or("member").into(),
        enabled: true,
        interval_seconds: 300,
    };
    entry(endpoint, device)?
        .set_password(&token)
        .map_err(|_| "cloud_keychain_unavailable")?;
    usage_sync::write_json(&data.join("cloud-members.json"), &me["members"])?;
    import_groups(data, &cfg, &me)?;
    usage_sync::reset_cloud_runtime(data)?;
    // Publish the cloud connection only after migration is ready. A Git-era
    // success timestamp must never be presented as a successful cloud upload.
    usage_sync::write_json(&data.join(CONFIG), &cfg)?;
    Ok(())
}

#[tauri::command]
pub fn get_cloud_sync_status(app: tauri::AppHandle) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let mut members =
        tokei_usage::read_json(&data.join("cloud-members.json"), 65536).unwrap_or(json!([]));
    if let Some(rows) = members.as_array_mut() {
        for member in rows {
            if let Some(id) = member["deviceId"]
                .as_str()
                .filter(|s| usage_sync::safe_id(s))
            {
                if let Ok(payload) = tokei_usage::read_json(
                    &data.join("cloud-snapshots").join(format!("{id}.json")),
                    8 * 1024 * 1024,
                ) {
                    let models = payload["codex"]["ranges"]["today"]["models"].as_array();
                    member["costCoverage"] = json!({"knownModels":models.map_or(0, |m| m.iter().filter(|v| v["cost"].is_number()).count()),"totalModels":models.map_or(0, Vec::len)});
                }
            }
        }
    }
    Ok(json!({
        "config": config(&data)?,
        "sharedRevision": shared_state(&data)["revision"],
        "pricingReady": data.join("cloud-pricing.json").exists(),
        "members": members,
        "lastPulledAt": tokei_usage::read_json(&data.join("cloud-pull-status.json"), 1024)
            .ok()
            .and_then(|v| v["lastPulledAt"].as_str().map(str::to_owned)),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSetup {
    endpoint: String,
    invite_code: Option<String>,
    display_name: String,
    device_id: String,
    space_name: Option<String>,
    bootstrap_secret: Option<String>,
    share_task_details: Option<bool>,
}

#[tauri::command]
pub async fn connect_cloud_sync(app: tauri::AppHandle, setup: CloudSetup) -> Result<Value, String> {
    let CloudSetup {
        endpoint,
        invite_code,
        display_name,
        device_id,
        space_name,
        bootstrap_secret,
        share_task_details,
    } = setup;
    let _guard = usage_sync::RUN_LOCK.try_lock().map_err(|_| "sync_busy")?;
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let endpoint = normalize_endpoint(&endpoint)?;
    let name = display_name.trim();
    if name.is_empty() || name.len() > 192 || name.chars().any(char::is_control) {
        return Err("cloud_name_required".into());
    }
    let device = device_id.trim();
    if !usage_sync::safe_id(device) {
        return Err("cloud_device_required".into());
    }
    if let Some(existing) = config(&data)? {
        if existing.endpoint != endpoint || existing.device_id != device {
            return Err("cloud_identity_locked".into());
        }
        return get_cloud_sync_status(app);
    }
    verify_device(&data, device)?;
    let token = if let Ok(token) = entry(&endpoint, device)?.get_password() {
        token
    } else {
        let joined = if let Some(code) = invite_code.filter(|code| !code.trim().is_empty()) {
            request(
                &endpoint,
                "/v1/join",
                None,
                Some(json!({"inviteCode":code,"displayName":name,"deviceId":device})),
            )
            .await?
        } else {
            let space_name = space_name
                .filter(|value| !value.trim().is_empty())
                .ok_or("cloud_invite_required")?;
            let secret = bootstrap_secret
                .filter(|value| !value.is_empty())
                .ok_or("cloud_bootstrap_required")?;
            request_with_bootstrap(
                &endpoint,
                "/v1/spaces",
                None,
                Some(json!({"name":space_name.trim(),"displayName":name,"deviceId":device})),
                Some(&secret),
            )
            .await?
        };
        // Persist the credential before further requests, scoped to this server and device.
        joined["token"]
            .as_str()
            .ok_or("cloud_response_invalid")?
            .to_owned()
    };
    entry(&endpoint, device)?
        .set_password(&token)
        .map_err(|_| "cloud_keychain_unavailable")?;
    enroll(&data, &endpoint, token, Some(device)).await?;
    if let Some(mut cfg) = config(&data)? {
        cfg.share_task_details = share_task_details.unwrap_or(false);
        usage_sync::write_json(&data.join(CONFIG), &cfg)?;
    }
    if config(&data)?.is_some_and(|cfg| cfg.role == "owner") {
        let path = data.join("usage-groups.json");
        if tokei_usage::read_json(&path, 65536)
            .ok()
            .and_then(|v| v["groups"].as_array().map(Vec::is_empty))
            .unwrap_or(true)
        {
            let groups = tokei_usage::GroupSettings {
                groups: vec![tokei_usage::UsageGroup {
                    id: "member-1".into(),
                    name: name.into(),
                    device_ids: vec![device.into()],
                }],
                default_group_id: Some("member-1".into()),
            };
            tokei_usage::save_groups(&path, &groups)?;
        }
    }
    get_cloud_sync_status(app)
}

#[tauri::command]
pub async fn create_cloud_invite(app: tauri::AppHandle) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let cfg = config(&data)?.ok_or("cloud_not_connected")?;
    let token = entry(&cfg.endpoint, &cfg.device_id)?
        .get_password()
        .map_err(|_| "cloud_keychain_unavailable")?;
    request(
        &cfg.endpoint,
        "/v1/invites",
        Some(&token),
        Some(json!({"maxUses": 1, "expiresHours": 24})),
    )
    .await
}

#[tauri::command]
pub async fn revoke_cloud_device(
    app: tauri::AppHandle,
    device_id: String,
) -> Result<Value, String> {
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let cfg = config(&data)?.ok_or("cloud_not_connected")?;
    if cfg.role != "owner" || device_id == cfg.device_id || !usage_sync::safe_id(&device_id) {
        return Err("cloud_device_revoke_denied".into());
    }
    let token = entry(&cfg.endpoint, &cfg.device_id)?
        .get_password()
        .map_err(|_| "cloud_keychain_unavailable")?;
    request(
        &cfg.endpoint,
        "/v1/devices/revoke",
        Some(&token),
        Some(json!({"deviceId":device_id})),
    )
    .await?;
    refresh_members(&data, &cfg, &token).await?;
    get_cloud_sync_status(app)
}

#[tauri::command]
pub fn set_cloud_sync_enabled(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    let _guard = usage_sync::RUN_LOCK.try_lock().map_err(|_| "sync_busy")?;
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let mut cfg = config(&data)?.ok_or("cloud_not_connected")?;
    cfg.enabled = enabled;
    usage_sync::write_json(&data.join(CONFIG), &cfg)?;
    get_cloud_sync_status(app)
}

#[tauri::command]
pub fn set_cloud_task_sharing(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    let _guard = usage_sync::RUN_LOCK.try_lock().map_err(|_| "sync_busy")?;
    let data = app
        .path()
        .app_config_dir()
        .map_err(|_| "sync_storage_unavailable")?;
    let mut cfg = config(&data)?.ok_or("cloud_not_connected")?;
    cfg.share_task_details = enabled;
    usage_sync::write_json(&data.join(CONFIG), &cfg)?;
    get_cloud_sync_status(app)
}

pub async fn exchange(data: &Path, payload: Value) -> Result<(), String> {
    let cfg = config(data)?.ok_or("cloud_not_connected")?;
    if payload["_device"] != cfg.device_id {
        return Err("cloud_identity_mismatch".into());
    }
    if serde_json::to_vec(&payload)
        .map_err(|_| "snapshot_invalid")?
        .len()
        > 1000 * 1024
    {
        return Err("cloud_snapshot_too_large".into());
    }
    let token = entry(&cfg.endpoint, &cfg.device_id)?
        .get_password()
        .map_err(|_| "cloud_keychain_unavailable")?;
    let mut body = json!({"deviceId":cfg.device_id,"payload":payload});
    body["clientInfo"] = json!({"protocolVersion":2,"appVersion":env!("CARGO_PKG_VERSION"),"settingsRevision":shared_state(data)["revision"]});
    let result = request(&cfg.endpoint, "/v1/sync", Some(&token), Some(body)).await?;
    cache_snapshots(data, &result)?;
    refresh_members(data, &cfg, &token).await
}

// Download peers before collecting local usage so a blocked local file cannot
// hide another member's already-uploaded data.
pub async fn pull(data: &Path) -> Result<(), String> {
    let cfg = config(data)?.ok_or("cloud_not_connected")?;
    let token = entry(&cfg.endpoint, &cfg.device_id)?
        .get_password()
        .map_err(|_| "cloud_keychain_unavailable")?;
    let result = request(&cfg.endpoint, "/v1/snapshots", Some(&token), None).await?;
    cache_snapshots(data, &result)?;
    synchronize_settings(data, &cfg, &token).await?;
    refresh_members(data, &cfg, &token).await
}

async fn refresh_members(data: &Path, cfg: &CloudConfig, token: &str) -> Result<(), String> {
    let me = request(&cfg.endpoint, "/v1/me", Some(token), None).await?;
    usage_sync::write_json(&data.join("cloud-members.json"), &me["members"])?;
    import_groups(data, cfg, &me)?;
    usage_sync::write_json(
        &data.join("cloud-pull-status.json"),
        &json!({"lastPulledAt": chrono::Utc::now().to_rfc3339()}),
    )
}

fn cache_snapshots(data: &Path, result: &Value) -> Result<(), String> {
    let rows = result["snapshots"]
        .as_array()
        .filter(|a| a.len() <= 32)
        .ok_or("cloud_response_invalid")?;
    // Validate every device before making any peer cache writes.
    for row in rows {
        let id = row["deviceId"]
            .as_str()
            .filter(|id| usage_sync::safe_id(id))
            .ok_or("cloud_response_invalid")?;
        if row["payload"]["_device"] != id
            || row["payload"]["_ts"]
                .as_i64()
                .is_none_or(|ts| ts <= 0 || ts > chrono::Utc::now().timestamp() + 300)
            || tokei_usage::parse_device(&row["payload"], id, None).is_none()
        {
            return Err("cloud_response_invalid".into());
        }
    }
    for row in rows {
        let id = row["deviceId"].as_str().ok_or("cloud_response_invalid")?;
        let path = data.join("cloud-snapshots").join(format!("{id}.json"));
        let previous = tokei_usage::read_json(&path, 8 * 1024 * 1024).ok();
        if previous
            .as_ref()
            .and_then(|p| p["_ts"].as_i64())
            .unwrap_or(0)
            <= row["payload"]["_ts"].as_i64().unwrap_or(0)
        {
            usage_sync::write_json(&path, &row["payload"])?;
        }
    }
    Ok(())
}

fn import_groups(data: &Path, cfg: &CloudConfig, me: &Value) -> Result<(), String> {
    // Legacy bootstrap only. Once v2 settings have been applied, their
    // revisioned groups must not be overwritten by the unversioned v1 copy.
    if cfg.role != "owner"
        && shared_state(data)["value"].is_null()
        && !me["groupSettings"].is_null()
    {
        let groups: tokei_usage::GroupSettings =
            serde_json::from_value(me["groupSettings"].clone())
                .map_err(|_| "cloud_groups_invalid")?;
        let path = data.join("usage-groups.json");
        let backup = data.join("usage-groups-before-cloud.json");
        if path.exists() && !backup.exists() {
            usage_sync::write_json(&backup, &tokei_usage::read_json(&path, 65536)?)?;
        }
        tokei_usage::save_groups(&path, &groups)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "cockpit-cloud-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap(),
                FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn enrollment_preserves_existing_device_before_any_network_or_credential_write() {
        let f = Fixture::new();
        usage_sync::write_json(
            &f.0.join("usage-sync.json"),
            &json!({"deviceId":"Windows-Test"}),
        )
        .unwrap();
        assert!(verify_device(&f.0, "Windows-Test").is_ok());
        assert_eq!(
            verify_device(&f.0, "Mac-Test").unwrap_err(),
            "cloud_identity_mismatch"
        );
        assert!(verify_device(&f.0, "../escape").is_err());
        assert!(!f.0.join(CONFIG).exists());
    }
    #[test]
    fn cloud_configuration_replaces_existing_file_without_losing_fields() {
        let f = Fixture::new();
        let mut cfg = CloudConfig {
            endpoint: "https://sync.example.com".into(),
            share_task_details: false,
            device_id: "Windows-Test".into(),
            space_id: "test-space".into(),
            space_name: "Test".into(),
            role: "member".into(),
            enabled: true,
            interval_seconds: 300,
        };
        usage_sync::write_json(&f.0.join(CONFIG), &cfg).unwrap();
        cfg.enabled = false;
        usage_sync::write_json(&f.0.join(CONFIG), &cfg).unwrap();
        let restored = config(&f.0).unwrap().unwrap();
        assert!(!restored.enabled);
        assert_eq!(restored.device_id, "Windows-Test");
        assert_eq!(restored.interval_seconds, 300);
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "Explicit native Credential Manager smoke with a disposable synthetic entry"]
    fn windows_credential_manager_roundtrip() {
        let id = format!(
            "cockpit-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let credential = entry("https://sync.example.com", &id).unwrap();
        credential
            .set_password("synthetic-credential-not-an-account")
            .unwrap();
        let read = credential.get_password();
        let cleanup = credential.delete_credential();
        assert_eq!(read.unwrap(), "synthetic-credential-not-an-account");
        cleanup.unwrap();
        assert!(matches!(
            credential.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn endpoint_is_explicit_https_and_credentials_are_scoped_to_its_origin() {
        assert_eq!(
            normalize_endpoint(" https://sync.example.com/ ").unwrap(),
            "https://sync.example.com"
        );
        for invalid in [
            "",
            "http://sync.example.com",
            "https://user:password@sync.example.com",
            "https://sync.example.com/path",
            "https://sync.example.com?token=secret",
            "https://sync.example.com#fragment",
        ] {
            assert!(normalize_endpoint(invalid).is_err());
        }
        assert_ne!(
            credential_key("https://one.example.com", "laptop"),
            credential_key("https://two.example.com", "laptop")
        );
    }

    #[test]
    fn catalog_number_encoding_does_not_create_false_revisions() {
        let wire =
            json!({"pricing":{"models":{"gpt-test":{"in":2,"out":4,"cache_read":1}},"aliases":{}}});
        let native = json!({"pricing":{"models":{"gpt-test":{"in":2.0,"out":4.0,"cache_read":1.0}},"aliases":{}}});
        assert!(settings_equal(&wire, &native));
        let mut changed = native.clone();
        changed["pricing"]["models"]["gpt-test"]["out"] = json!(5.0);
        assert!(!settings_equal(&wire, &changed));
        assert!(!settings_equal(&Value::Null, &native));
    }
    #[test]
    fn owner_pricing_refresh_keeps_groups_edited_by_another_device() {
        let remote = json!({"revision":4,"value":{"groups":{"groups":[{"id":"blair","name":"成员乙","deviceIds":["windows"]}],"defaultGroupId":"blair"}}});
        let local = json!({"groups":[{"id":"alex","name":"成员甲","deviceIds":["mac"]}],"defaultGroupId":"alex"});
        let pricing = json!({"models":{"test":{"in":1,"out":2,"cache_read":0.5}},"aliases":{}});
        let next = owner_settings_value(&remote, local, pricing);
        assert_eq!(next["groups"], remote["value"]["groups"]);
    }
    #[test]
    fn shared_catalog_is_validated_stale_safe_and_does_not_touch_private_preferences() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("cockpit-shared-contract-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut value = json!({"revision":1,"value":{"schemaVersion":2,"costPolicy":"event-context-v1","groups":{"groups":[],"defaultGroupId":null},"pricing":{"models":{"test":{"in":1,"out":2,"cache_read":0.5}},"aliases":{}}}});
        apply_shared(&root, &value).unwrap();
        let before = std::fs::read(root.join("cloud-pricing.json")).unwrap();
        value["revision"] = json!(2);
        value["value"]["groups"] = json!({"groups":[{"id":"alex","name":"成员甲","deviceIds":["mac"]}],"defaultGroupId":"alex"});
        apply_shared(&root, &value).unwrap();
        assert_eq!(
            tokei_usage::read_json(&root.join("usage-groups.json"), 65536).unwrap(),
            value["value"]["groups"]
        );
        value["revision"] = json!(0);
        assert_eq!(
            apply_shared(&root, &value).unwrap_err(),
            "cloud_settings_stale"
        );
        value["revision"] = json!(3);
        value["value"]["pricing"]["models"]["test"]["in"] = json!(-1);
        assert!(apply_shared(&root, &value).is_err());
        assert_eq!(
            std::fs::read(root.join("cloud-pricing.json")).unwrap(),
            before
        );
        assert!(!root.join("runtime-state.json").exists());
        assert!(!root.join("preferences.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

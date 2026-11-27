//! Aggregate-only Claude and Gemini usage carried with the existing cloud snapshot.
use crate::{claude_usage::ClaudeUsageReport, cloud_sync, tokei_usage, usage_sync};
use serde_json::{json, Map, Value};
use std::path::Path;

const MAX_PROVIDER_BYTES: usize = 256 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 1000 * 1024;

fn clean_name(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 256
        && !value.chars().any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}

fn projection(mut report: ClaudeUsageReport) -> Option<Value> {
    if report.days.is_empty() {
        return None;
    }
    for day in &mut report.days {
        day.tasks.clear();
        day.projects.clear();
        day.models
            .retain(|model| clean_name(&model.id) && clean_name(&model.name));
        day.models.truncate(256);
    }
    let mut days = Vec::new();
    let mut bytes = 0;
    for day in report.days.iter().rev() {
        let mut value = serde_json::to_value(day).ok()?;
        let object = value.as_object_mut()?;
        object.remove("tasks");
        object.remove("projects");
        let size = serde_json::to_vec(&value).ok()?.len() + 1;
        if bytes + size > MAX_PROVIDER_BYTES {
            break;
        }
        bytes += size;
        days.push(value);
    }
    days.reverse();
    Some(
        json!({"observedAt":report.observed_at,"latestActivityAt":report.latest_activity_at,"days":days}),
    )
}

pub(crate) fn collect(data: &Path) -> Map<String, Value> {
    let preferences = crate::load_preferences(&data.join("preferences.json"));
    [
        (
            "claude",
            preferences.claude_enabled,
            crate::claude_usage::read_usage as fn(u32) -> ClaudeUsageReport,
        ),
        (
            "gemini",
            preferences.gemini_enabled,
            crate::gemini_usage::read_usage,
        ),
    ]
    .into_iter()
    .filter_map(|(provider, enabled, collect)| {
        if !enabled {
            return None;
        }
        Some((provider.into(), projection(collect(400))?))
    })
    .collect()
}

pub(crate) fn attach(payload: &mut Value, reports: Map<String, Value>) {
    for (provider, report) in reports {
        payload["providerUsage"][&provider] = report;
        if serde_json::to_vec(payload).map_or(true, |body| body.len() > MAX_SNAPSHOT_BYTES) {
            if let Some(providers) = payload["providerUsage"].as_object_mut() {
                providers.remove(&provider);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn get_shared_provider_usage(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let data = crate::app_config_dir(&app).map_err(|_| "sync_storage_unavailable")?;
    let Some(cfg) = cloud_sync::config(&data)?.filter(|cfg| cfg.enabled) else {
        return Ok(Vec::new());
    };
    let members =
        tokei_usage::read_json(&data.join("cloud-members.json"), 65536).unwrap_or_default();
    Ok(members
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|member| {
            let id = member["deviceId"]
                .as_str()
                .filter(|id| usage_sync::safe_id(id) && *id != cfg.device_id)?;
            let payload = tokei_usage::read_json(
                &data.join("cloud-snapshots").join(format!("{id}.json")),
                1024 * 1024,
            )
            .ok()?;
            if payload["_localProviderSpace"] != cfg.space_id || payload["_device"] != id {
                return None;
            }
            let usage = payload.get("providerUsage")?.as_object()?;
            Some(json!({"deviceId":id, "deviceName":member["displayName"], "usage":usage}))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_usage::{ClaudeDailyUsage, ClaudeModelUsage};

    #[test]
    fn projection_keeps_unknown_cost_but_omits_task_and_path_metadata() {
        let row = ClaudeModelUsage {
            id: "gemini-4-carbon".into(),
            name: "Gemini 4 Carbon".into(),
            requests: 1,
            input_tokens: 50,
            ..Default::default()
        };
        let private_row = ClaudeModelUsage {
            id: "/private/work".into(),
            name: "local task title".into(),
            ..Default::default()
        };
        let result = projection(ClaudeUsageReport {
            status: "ok",
            observed_at: "2026-11-26T10:00:00Z".into(),
            latest_activity_at: None,
            price_checked_at: "",
            prices: Vec::new(),
            days: vec![ClaudeDailyUsage {
                local_date: "2026-11-26".into(),
                requests: 1,
                unpriced_requests: 1,
                input_tokens: 50,
                models: vec![row],
                tasks: vec![private_row.clone()],
                projects: vec![private_row],
                ..Default::default()
            }],
        })
        .unwrap();
        let day = &result["days"][0];
        assert_eq!(day["unpricedRequests"], 1);
        assert_eq!(day["models"][0]["costUsd"], Value::Null);
        assert!(day.get("tasks").is_none());
        assert!(day.get("projects").is_none());
    }
}

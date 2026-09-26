//! Opted-in Cloudflare task summaries: explicit allowlist, no paths or messages.
use crate::{codex_project_usage::ProjectUsageSnapshot, tokei_usage, usage_sync};
use serde_json::{json, Value};
use std::path::Path;

pub fn attach(payload: &mut Value, source: &ProjectUsageSnapshot) {
    // Leave room for the existing device/comfort ledger in the 1 MiB request.
    let budget =
        900_000usize.saturating_sub(serde_json::to_vec(payload).map_or(900_000, |v| v.len()));
    let mut tasks = Vec::new();
    let mut used = 128;
    let mut partial = source.status != "ready";
    let mut ordered: Vec<_> = source.tasks.iter().collect();
    ordered.sort_by_key(|task| std::cmp::Reverse(task.daily.keys().next_back()));
    for task in ordered {
        let mut row =
            json!({"id":task.id,"name":task.name,"relation":task.relation,"daily":task.daily});
        if let Some(id) = &task.parent_id {
            row["parentId"] = json!(id);
        }
        if let Some(id) = &task.root_id {
            row["rootId"] = json!(id);
        }
        let size = serde_json::to_vec(&row).map_or(budget + 1, |v| v.len() + 1);
        if used + size > budget || tasks.len() >= 4000 {
            partial = true;
            continue;
        }
        used += size;
        tasks.push(row);
    }
    payload["taskUsage"] = json!({"version":1,"partial":partial,"tasks":tasks});
}

pub fn read_peers(data: &Path, local_id: &str) -> Vec<Value> {
    // Only read devices in the authenticated cloud roster; never stale revoked files.
    let members =
        tokei_usage::read_json(&data.join("cloud-members.json"), 1024 * 1024).unwrap_or(json!([]));
    let mut peers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for member in members.as_array().into_iter().flatten().take(32) {
        let Some(id) = member["deviceId"]
            .as_str()
            .filter(|id| usage_sync::safe_id(id))
        else {
            continue;
        };
        if id == local_id || !seen.insert(id) {
            continue;
        }
        let Ok(snapshot) = tokei_usage::read_json(
            &data.join("cloud-snapshots").join(format!("{id}.json")),
            1024 * 1024,
        ) else {
            continue;
        };
        let usage = &snapshot["taskUsage"];
        if snapshot["_device"] != id || usage["version"] != 1 {
            continue;
        }
        let Some(tasks) = usage["tasks"].as_array().filter(|rows| rows.len() <= 4000) else {
            continue;
        };
        // Published payloads are validated by the authenticated Worker. Pass only
        // the task fields defined by this version, never arbitrary snapshot data.
        let rows: Vec<_> = tasks.iter().map(|task| {
            let mut row = json!({"id":task["id"],"name":task["name"],"relation":task["relation"],"daily":task["daily"]});
            for key in ["parentId", "rootId"] { if let Some(value) = task.get(key) { row[key] = value.clone(); } }
            row
        }).collect();
        let timestamp = snapshot["_ts"]
            .as_i64()
            .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
            .map(|ts| ts.to_rfc3339());
        peers.push(
            json!({"deviceId":id,"updatedAt":timestamp,"partial":usage["partial"],"tasks":rows}),
        );
    }
    peers
}

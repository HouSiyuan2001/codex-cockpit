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
        let snapshot = tokei_usage::read_json(
            &data.join("cloud-snapshots").join(format!("{id}.json")),
            1024 * 1024,
        )
        .ok();
        peers.push(peer_summary(id, snapshot.as_ref()));
    }
    peers
}

fn peer_summary(id: &str, snapshot: Option<&Value>) -> Value {
    let snapshot = snapshot.filter(|snapshot| snapshot["_device"] == id);
    let usage = snapshot.map(|snapshot| &snapshot["taskUsage"]);
    let tasks = usage
        .filter(|usage| usage["version"] == 1)
        .and_then(|usage| usage["tasks"].as_array())
        .filter(|rows| rows.len() <= 4000);
    let state = if tasks.is_some() {
        "available"
    } else if snapshot.is_some_and(|snapshot| snapshot.get("taskUsage").is_none()) {
        // An omitted field can mean opt-out or an older publisher. Do not claim
        // the remote preference is known, or turn missing details into zero use.
        "not-provided"
    } else {
        "not-received"
    };
    // Preserve a status row for every authenticated peer, even when task details
    // are absent. Never load data for an unlisted or mismatched device.
    let rows: Vec<_> = tasks.into_iter().flatten().map(|task| {
            let mut row = json!({"id":task["id"],"name":task["name"],"relation":task["relation"],"daily":task["daily"]});
            for key in ["parentId", "rootId"] { if let Some(value) = task.get(key) { row[key] = value.clone(); } }
            row
        }).collect();
    let timestamp = snapshot
        .and_then(|snapshot| snapshot["_ts"].as_i64())
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .map(|ts| ts.to_rfc3339());
    json!({"deviceId":id,"updatedAt":timestamp,"partial":tasks.is_none() || usage.is_some_and(|usage| usage["partial"] == true),"taskDetailsStatus":state,"tasks":rows})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_only_peer_is_not_silently_dropped_or_claimed_to_have_zero_usage() {
        let snapshot = json!({"_device":"peer","_ts":1_700_000_000,"codex":{"today":123}});
        let row = peer_summary("peer", Some(&snapshot));
        assert_eq!(row["deviceId"], "peer");
        assert_eq!(row["taskDetailsStatus"], "not-provided");
        assert_eq!(row["partial"], true);
        assert!(row["updatedAt"].is_string());
        assert!(row.get("codex").is_none());
    }

    #[test]
    fn missing_mismatched_and_unsupported_snapshots_do_not_expose_task_data() {
        assert_eq!(
            peer_summary("peer", None)["taskDetailsStatus"],
            "not-received"
        );
        for snapshot in [
            json!({"_device":"someone-else","taskUsage":{"version":1,"tasks":[{"name":"private"}]}}),
            json!({"_device":"peer","taskUsage":{"version":99,"tasks":[{"name":"private"}]}}),
        ] {
            let row = peer_summary("peer", Some(&snapshot));
            assert_eq!(row["taskDetailsStatus"], "not-received");
            assert_eq!(row["tasks"], json!([]));
        }
    }

    #[test]
    fn shared_empty_tasks_and_allowlisted_task_fields_stay_distinct_from_opt_out() {
        let empty = json!({"_device":"peer","taskUsage":{"version":1,"partial":false,"tasks":[]}});
        assert_eq!(
            peer_summary("peer", Some(&empty))["taskDetailsStatus"],
            "available"
        );
        let snapshot = json!({"_device":"peer","taskUsage":{"version":1,"partial":true,"tasks":[{"id":"t","name":"Synthetic task","relation":"root","daily":{},"projectPath":"private-path","message":"private-message"}]}});
        let row = peer_summary("peer", Some(&snapshot));
        assert_eq!(row["taskDetailsStatus"], "available");
        assert_eq!(row["partial"], true);
        assert_eq!(row["tasks"][0]["name"], "Synthetic task");
        assert!(row["tasks"][0].get("projectPath").is_none());
        assert!(row["tasks"][0].get("message").is_none());
    }
}

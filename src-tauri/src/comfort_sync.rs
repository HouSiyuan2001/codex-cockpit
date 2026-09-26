//! Privacy-bounded comfort-feedback projection for the app-owned usage snapshot.
//!
//! Only explicitly assigned feedback is eligible for sync. Runtime state is read-only;
//! unrelated application fields and malformed records never enter the wire format.

use crate::tokei_usage;
use chrono::{DateTime, Local, NaiveDate, Utc};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

pub const FEEDBACK_VERSION: u64 = 1;
const MAX_RUNTIME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DEVICE_FILES: usize = 128;
const MAX_RUNTIME_RECORDS: usize = 4096;
const MAX_PERSONS: usize = 32;
const MAX_RECORDS_PER_PERSON: usize = 90;
const MAX_MODELS: usize = 128;
const MAX_TOKEN_DEVICES: usize = 64;
const MAX_ALLOCATION_DEVICES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DAILY_OBSERVED_PERCENT: f64 = 10_000.0;
const FUTURE_TOLERANCE_SECONDS: i64 = 300;
const CURRENT_CURVE_VERSION: &str = "p014-t014-ordinal-map-v3";
const LEGACY_CURVE_VERSIONS: [&str; 2] = ["p014-t014-smooth-knee-v2", "p014-t014-y-v1"];
const TOKEN_METRIC_VERSION: &str = "p020-person-calendar-token-v1";
const ALLOCATION_METRIC_VERSION: &str = "cost-share-v1";

/// Attach a last-edit-wins union of prior same-device feedback and the local runtime.
///
/// Missing runtime feedback preserves prior synced records. Corrupt runtime JSON or a
/// malformed prior extension fails closed so a usage refresh cannot publish an empty
/// replacement over recoverable feedback.
pub fn attach_local_feedback(
    payload: &mut Value,
    runtime_path: &Path,
    baselines: &[Value],
) -> Result<(), String> {
    let device_id = payload
        .get("_device")
        .and_then(Value::as_str)
        .filter(|value| safe_text(value, 128))
        .ok_or_else(|| "snapshot_identity_mismatch".to_string())?;
    let now = Utc::now();
    let mut records = baseline_records(baselines, device_id, now)?;
    if let Some(local) = read_local_assigned(runtime_path, now)? {
        records.extend(local);
    }
    let records = merge_bounded(records);
    if !records.is_empty() {
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "snapshot_invalid".to_string())?;
        object.insert("comfortFeedbackVersion".into(), json!(FEEDBACK_VERSION));
        object.insert("comfortFeedback".into(), Value::Array(records));
    }
    if serde_json::to_vec(payload)
        .map_err(|_| "snapshot_invalid")?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err("snapshot_too_large".into());
    }
    Ok(())
}

/// Aggregate sanitized feedback from an already-fetched app-owned checkout.
///
/// Individual malformed/unknown-version device files are isolated. Repository shape,
/// scan count, total bytes, and final IPC response size remain bounded.
pub fn read_synced_feedback(cockpit: &Path) -> Result<Vec<Value>, String> {
    if !cockpit.exists() {
        return Ok(Vec::new());
    }
    ensure_safe_existing_path(cockpit)?;
    let meta = fs::symlink_metadata(cockpit).map_err(|_| "comfort_sync_unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("unsafe_comfort_sync_path".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(cockpit).map_err(|_| "comfort_sync_unavailable")? {
        if entries.len() >= MAX_DEVICE_FILES {
            return Err("comfort_feedback_scan_limit".into());
        }
        let entry = entry.map_err(|_| "comfort_sync_unavailable")?;
        entries.push(entry.path());
    }
    entries.sort();

    let now = Utc::now();
    let mut scanned = 0_u64;
    let mut records = Vec::new();
    for path in entries {
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(device_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !safe_file_id(device_id) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_RUNTIME_BYTES {
            continue;
        }
        scanned = scanned.saturating_add(meta.len());
        if scanned > MAX_SCAN_BYTES {
            return Err("comfort_feedback_scan_limit".into());
        }
        let Ok(value) = tokei_usage::read_json(&path, MAX_RUNTIME_BYTES) else {
            continue;
        };
        if value.get("_device").and_then(Value::as_str) != Some(device_id)
            || value
                .get("_ts")
                .and_then(Value::as_i64)
                .is_none_or(|timestamp| {
                    timestamp <= 0 || timestamp > now.timestamp() + FUTURE_TOLERANCE_SECONDS
                })
            || value.get("comfortFeedbackVersion").and_then(Value::as_u64) != Some(FEEDBACK_VERSION)
        {
            continue;
        }
        let Some(rows) = value.get("comfortFeedback").and_then(Value::as_array) else {
            continue;
        };
        for row in rows.iter().take(MAX_RUNTIME_RECORDS) {
            if let Some(record) = sanitize_assigned_record(row, now) {
                records.push(record);
            }
        }
    }
    let records = merge_bounded(records);
    if serde_json::to_vec(&records)
        .map_err(|_| "comfort_feedback_invalid")?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err("comfort_feedback_scan_limit".into());
    }
    Ok(records)
}

fn read_local_assigned(
    runtime_path: &Path,
    now: DateTime<Utc>,
) -> Result<Option<Vec<Value>>, String> {
    let candidates = [
        runtime_path.to_path_buf(),
        runtime_path.with_extension("json.bak"),
    ];
    let mut saw_candidate = false;
    for path in candidates {
        if !path.try_exists().map_err(|_| "comfort_state_unavailable")? {
            continue;
        }
        saw_candidate = true;
        let Ok(value) = tokei_usage::read_json(&path, MAX_RUNTIME_BYTES) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(feedback) = object.get("comfortFeedback") else {
            return Ok(None);
        };
        let Some(rows) = feedback
            .as_array()
            .filter(|rows| rows.len() <= MAX_RUNTIME_RECORDS)
        else {
            continue;
        };
        let mut records = Vec::new();
        let mut invalid_assigned = false;
        for row in rows {
            let assigned = row
                .as_object()
                .and_then(|object| object.get("personId"))
                .is_some_and(|person_id| !person_id.is_null());
            if !assigned {
                continue;
            }
            match sanitize_assigned_record(row, now) {
                Some(record) => records.push(record),
                None => invalid_assigned = true,
            }
        }
        if !invalid_assigned {
            return Ok(Some(records));
        }
    }
    if saw_candidate {
        Err("comfort_state_invalid".into())
    } else {
        Ok(None)
    }
}

fn baseline_records(
    baselines: &[Value],
    device_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<Value>, String> {
    let mut records = Vec::new();
    for baseline in baselines {
        if baseline.get("_device").and_then(Value::as_str) != Some(device_id) {
            continue;
        }
        let has_version = baseline.get("comfortFeedbackVersion").is_some();
        let has_feedback = baseline.get("comfortFeedback").is_some();
        if !has_version && !has_feedback {
            continue;
        }
        if baseline
            .get("comfortFeedbackVersion")
            .and_then(Value::as_u64)
            != Some(FEEDBACK_VERSION)
        {
            return Err("comfort_feedback_version_unsupported".into());
        }
        let rows = baseline
            .get("comfortFeedback")
            .and_then(Value::as_array)
            .filter(|rows| rows.len() <= MAX_RUNTIME_RECORDS)
            .ok_or_else(|| "synced_comfort_feedback_invalid".to_string())?;
        for row in rows {
            records.push(
                sanitize_assigned_record(row, now)
                    .ok_or_else(|| "synced_comfort_feedback_invalid".to_string())?,
            );
        }
    }
    Ok(records)
}

fn sanitize_assigned_record(value: &Value, now: DateTime<Utc>) -> Option<Value> {
    let object = value.as_object()?;
    let local_date = valid_local_date(object.get("localDate")?.as_str()?)?;
    if local_date > Local::now().date_naive() {
        return None;
    }
    let observed_at = valid_timestamp(object.get("observedAt")?.as_str()?, now)?;
    let updated_at = match object.get("updatedAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(valid_timestamp(value.as_str()?, now)?),
    };
    let comfort = match object.get("comfort")?.as_str()? {
        value @ ("overloaded" | "comfortable" | "idle") => value,
        _ => return None,
    };
    let person_id = object.get("personId")?.as_str()?;
    if !safe_text(person_id, 128) {
        return None;
    }
    let person_name = match object.get("personName") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => {
            let name = value.as_str()?.trim();
            if !safe_text(name, 64) {
                return None;
            }
            json!(name)
        }
    };
    let observed_used = nullable_number(
        object.get("observedUsedPercent")?,
        0.0,
        MAX_DAILY_OBSERVED_PERCENT,
    )?;
    let usage_observed_at = match object.get("usageObservedAt")? {
        Value::Null => Value::Null,
        Value::String(value) => json!(valid_timestamp(value, now)?),
        _ => return None,
    };
    let usage_coverage = coverage(object.get("usageCoverage")?.as_str()?)?;
    let usage_source = match object.get("usageSource")?.as_str()? {
        value @ ("official-snapshot" | "local-history" | "unavailable") => value,
        _ => return None,
    };
    let curve = object.get("curveVersion")?.as_str()?;
    if curve != CURRENT_CURVE_VERSION && !LEGACY_CURVE_VERSIONS.contains(&curve) {
        return None;
    }
    let token_snapshot = match object.get("tokenSnapshot") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => sanitize_token_snapshot(value, &local_date.to_string(), now)?,
    };
    let quota_allocation = match object.get("quotaAllocation") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => {
            sanitize_quota_allocation(value, &local_date.to_string(), observed_used.as_f64(), now)?
        }
    };

    let mut result = Map::new();
    result.insert("localDate".into(), json!(local_date.to_string()));
    result.insert("observedAt".into(), json!(observed_at));
    if let Some(updated_at) = updated_at {
        result.insert("updatedAt".into(), json!(updated_at));
    }
    result.insert("comfort".into(), json!(comfort));
    result.insert("personId".into(), json!(person_id));
    result.insert("personName".into(), person_name);
    result.insert("tokenSnapshot".into(), token_snapshot);
    result.insert("quotaAllocation".into(), quota_allocation);
    result.insert("observedUsedPercent".into(), observed_used);
    result.insert("usageObservedAt".into(), usage_observed_at);
    result.insert("usageCoverage".into(), json!(usage_coverage));
    result.insert("usageSource".into(), json!(usage_source));
    result.insert("curveVersion".into(), json!(CURRENT_CURVE_VERSION));
    Some(Value::Object(result))
}

fn sanitize_token_snapshot(value: &Value, record_date: &str, now: DateTime<Utc>) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("localDate")?.as_str()? != record_date
        || object.get("metricVersion")?.as_str()? != TOKEN_METRIC_VERSION
    {
        return None;
    }
    let observed_at = valid_timestamp(object.get("observedAt")?.as_str()?, now)?;
    let coverage = coverage(object.get("coverage")?.as_str()?)?;
    let input = token_count(object.get("inputTokens")?)?;
    let cached = token_count(object.get("cachedInputTokens")?)?;
    let output = token_count(object.get("outputTokens")?)?;
    let reasoning = token_count(object.get("reasoningTokens")?)?;
    let total = input.checked_add(cached)?.checked_add(output)?;
    if total > MAX_SAFE_INTEGER {
        return None;
    }
    let models = object.get("models")?.as_array()?;
    if models.len() > MAX_MODELS {
        return None;
    }
    let mut clean_models = Vec::with_capacity(models.len());
    for model in models {
        let model = model.as_object()?;
        let id = model.get("id")?.as_str()?;
        let name = model.get("name")?.as_str()?;
        if !safe_text(id, 128) || !safe_text(name, 128) {
            return None;
        }
        let model_input = token_count(model.get("inputTokens")?)?;
        let model_cached = token_count(model.get("cachedInputTokens")?)?;
        let model_output = token_count(model.get("outputTokens")?)?;
        let model_reasoning = token_count(model.get("reasoningTokens")?)?;
        let model_total = model_input
            .checked_add(model_cached)?
            .checked_add(model_output)?;
        if model_total > MAX_SAFE_INTEGER {
            return None;
        }
        clean_models.push(json!({
            "id":id,"name":name,"inputTokens":model_input,"cachedInputTokens":model_cached,
            "outputTokens":model_output,"reasoningTokens":model_reasoning,"totalTokens":model_total
        }));
    }
    let device_ids = string_array(object.get("deviceIds")?, MAX_TOKEN_DEVICES)?;
    let missing = string_array(object.get("missingDeviceIds")?, MAX_TOKEN_DEVICES)?;
    let incomplete = string_array(
        object
            .get("incompleteDeviceIds")
            .unwrap_or(&Value::Array(Vec::new())),
        MAX_TOKEN_DEVICES,
    )?;
    Some(json!({
        "localDate":record_date,"observedAt":observed_at,"metricVersion":TOKEN_METRIC_VERSION,
        "coverage":coverage,"inputTokens":input,"cachedInputTokens":cached,"outputTokens":output,
        "reasoningTokens":reasoning,"totalTokens":total,"models":clean_models,"deviceIds":device_ids,
        "missingDeviceIds":missing,"incompleteDeviceIds":incomplete
    }))
}

fn sanitize_quota_allocation(
    value: &Value,
    record_date: &str,
    record_total: Option<f64>,
    now: DateTime<Utc>,
) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("metricVersion")?.as_str()? != ALLOCATION_METRIC_VERSION
        || object.get("localDate")?.as_str()? != record_date
    {
        return None;
    }
    let observed_at = valid_timestamp(object.get("observedAt")?.as_str()?, now)?;
    let mut allocation_coverage = coverage(object.get("coverage")?.as_str()?)?;
    let candidate_total = nullable_f64(
        object.get("totalUsedPercent")?,
        0.0,
        MAX_DAILY_OBSERVED_PERCENT,
    )?;
    // Validate the wire values even though the derived share/allocation below are
    // recomputed from costs and the trusted shared total. This keeps malformed
    // daily percentages out of the accepted input while preventing stale or
    // user-supplied derived values from influencing the published result.
    let _candidate_share = nullable_f64(object.get("costShare")?, 0.0, 1.0)?;
    let _candidate_allocated = nullable_f64(
        object.get("allocatedUsedPercent")?,
        0.0,
        MAX_DAILY_OBSERVED_PERCENT,
    )?;
    let total_used = record_total.or(candidate_total);
    let person_cost = nullable_f64(object.get("personCostUsd")?, 0.0, 1_000_000_000.0)?;
    let total_cost = nullable_f64(object.get("totalCostUsd")?, 0.0, 1_000_000_000.0)?;
    if person_cost
        .is_some_and(|person| total_cost.is_none_or(|total| total <= 0.0 || person > total + 1e-9))
    {
        return None;
    }
    let device_ids = string_array(object.get("deviceIds")?, MAX_ALLOCATION_DEVICES)?;
    let missing = string_array(object.get("missingDeviceIds")?, MAX_ALLOCATION_DEVICES)?;
    let cost_share = match (person_cost, total_cost) {
        (Some(person), Some(total)) if total > 0.0 => {
            Some(round((person / total).clamp(0.0, 1.0), 8))
        }
        _ => None,
    };
    let allocated = match (total_used, cost_share) {
        (Some(total), Some(share)) => Some(round((total * share).clamp(0.0, total), 4)),
        _ => None,
    };
    if allocation_coverage == "complete"
        && (cost_share.is_none() || allocated.is_none() || !missing.is_empty())
    {
        allocation_coverage = "partial";
    }
    let (person_cost, total_cost, cost_share, allocated) = if allocation_coverage == "unavailable" {
        (None, None, None, None)
    } else {
        (person_cost, total_cost, cost_share, allocated)
    };
    Some(json!({
        "metricVersion":ALLOCATION_METRIC_VERSION,"localDate":record_date,"observedAt":observed_at,
        "totalUsedPercent":total_used,"personCostUsd":person_cost,"totalCostUsd":total_cost,
        "costShare":cost_share,"allocatedUsedPercent":allocated,"coverage":allocation_coverage,
        "deviceIds":device_ids,"missingDeviceIds":missing
    }))
}

fn merge_bounded(records: Vec<Value>) -> Vec<Value> {
    let mut latest: BTreeMap<(String, String), Value> = BTreeMap::new();
    for record in records {
        let Some(person) = record.get("personId").and_then(Value::as_str) else {
            continue;
        };
        let Some(date) = record.get("localDate").and_then(Value::as_str) else {
            continue;
        };
        let key = (person.to_owned(), date.to_owned());
        let replace = latest.get(&key).is_none_or(|previous| {
            let next_revision = revision(&record);
            let old_revision = revision(previous);
            next_revision > old_revision
                || (next_revision == old_revision
                    && canonical_json(&record) > canonical_json(previous))
        });
        if replace {
            latest.insert(key, record);
        }
    }
    let mut people: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for ((person, _), record) in latest {
        people.entry(person).or_default().push(record);
    }
    let mut people: Vec<_> = people.into_iter().collect();
    people.sort_by(|left, right| {
        let left_latest = left.1.iter().map(revision).max().unwrap_or(i64::MIN);
        let right_latest = right.1.iter().map(revision).max().unwrap_or(i64::MIN);
        right_latest
            .cmp(&left_latest)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut result = Vec::new();
    for (_, mut rows) in people.into_iter().take(MAX_PERSONS) {
        rows.sort_by(|left, right| {
            left.get("localDate")
                .and_then(Value::as_str)
                .cmp(&right.get("localDate").and_then(Value::as_str))
                .then_with(|| revision(left).cmp(&revision(right)))
        });
        if rows.len() > MAX_RECORDS_PER_PERSON {
            rows.drain(..rows.len() - MAX_RECORDS_PER_PERSON);
        }
        result.extend(rows);
    }
    result
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn revision(value: &Value) -> i64 {
    value
        .get("updatedAt")
        .or_else(|| value.get("observedAt"))
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map_or(i64::MIN, |value| value.timestamp_millis())
}

fn valid_local_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .filter(|date| date.to_string() == value)
}

fn valid_timestamp(value: &str, now: DateTime<Utc>) -> Option<String> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .filter(|timestamp| timestamp.timestamp() <= now.timestamp() + FUTURE_TOLERANCE_SECONDS)
        .map(|_| value.to_owned())
}

fn coverage(value: &str) -> Option<&str> {
    matches!(value, "complete" | "partial" | "unavailable").then_some(value)
}

fn nullable_number(value: &Value, minimum: f64, maximum: f64) -> Option<Value> {
    match value {
        Value::Null => Some(Value::Null),
        _ => value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= minimum && *number <= maximum)
            .map(|number| json!(number)),
    }
}

fn nullable_f64(value: &Value, minimum: f64, maximum: f64) -> Option<Option<f64>> {
    match value {
        Value::Null => Some(None),
        _ => value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= minimum && *number <= maximum)
            .map(Some),
    }
}

fn token_count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn round(value: f64, precision: i32) -> f64 {
    let scale = 10_f64.powi(precision);
    (value * scale).round() / scale
}

fn string_array(value: &Value, maximum: usize) -> Option<Vec<String>> {
    let values = value.as_array()?;
    if values.len() > maximum {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
        let value = value.as_str()?;
        if !safe_text(value, 128) {
            return None;
        }
        if seen.insert(value.to_owned()) {
            result.push(value.to_owned());
        }
    }
    Some(result)
}

fn safe_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn safe_file_id(value: &str) -> bool {
    safe_text(value, 128)
        && value != "."
        && value != ".."
        && !value.starts_with(['-', '.'])
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn ensure_safe_existing_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("unsafe_comfort_sync_path".into());
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("unsafe_comfort_sync_path".into());
        }
        cursor.push(component.as_os_str());
        // A Windows drive prefix (C:) is drive-relative until RootDir follows.
        // Inspect only the completed absolute root, then every descendant.
        if matches!(component, Component::Prefix(_)) || !cursor.is_absolute() {
            continue;
        }
        if fs::symlink_metadata(&cursor)
            .map_err(|_| "comfort_sync_unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("unsafe_comfort_sync_path".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "comfort-sync-test-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
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

    fn record(person: Option<&str>, updated: &str) -> Value {
        json!({
            "localDate":"2026-09-10","observedAt":"2026-09-10T14:00:00Z","updatedAt":updated,
            "comfort":"comfortable","personId":person,"personName":" Alice ",
            "observedUsedPercent":40.0,"usageObservedAt":"2026-09-10T15:00:00Z",
            "usageCoverage":"complete","usageSource":"official-snapshot",
            "curveVersion":CURRENT_CURVE_VERSION,
            "tokenSnapshot":{
                "localDate":"2026-09-10","observedAt":"2026-09-10T15:00:00Z",
                "metricVersion":TOKEN_METRIC_VERSION,"coverage":"complete",
                "inputTokens":10,"cachedInputTokens":2,"outputTokens":3,"reasoningTokens":4,
                "totalTokens":999,"models":[{"id":"gpt","name":"GPT","inputTokens":10,
                    "cachedInputTokens":2,"outputTokens":3,"reasoningTokens":4,"totalTokens":999,
                    "raw":"private"}],"deviceIds":["mac"],"missingDeviceIds":[],
                "incompleteDeviceIds":[],"path":"private"
            },
            "quotaAllocation":{
                "metricVersion":ALLOCATION_METRIC_VERSION,"localDate":"2026-09-10",
                "observedAt":"2026-09-10T15:00:00Z","totalUsedPercent":40.0,
                "personCostUsd":2.0,"totalCostUsd":8.0,"costShare":0.99,
                "allocatedUsedPercent":99.0,"coverage":"complete","deviceIds":["mac"],
                "missingDeviceIds":[],"message":"private"
            },
            "rawResponse":"private","path":"/private/project","message":"private"
        })
    }

    fn daily_record(observed: Value, total: Value, share: Value, allocated: Value) -> Value {
        let mut value = record(Some("person-a"), "2026-09-10T16:00:00Z");
        value
            .as_object_mut()
            .unwrap()
            .insert("observedUsedPercent".into(), observed);
        value
            .get_mut("quotaAllocation")
            .and_then(Value::as_object_mut)
            .unwrap()
            .extend([
                ("totalUsedPercent".into(), total),
                ("costShare".into(), share),
                ("allocatedUsedPercent".into(), allocated),
            ]);
        value
    }

    #[test]
    fn sanitizer_exports_only_assigned_whitelisted_fields_and_recomputes_totals() {
        let now = DateTime::parse_from_rfc3339("2026-09-11T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(sanitize_assigned_record(&record(None, "2026-09-10T16:00:00Z"), now).is_none());
        let clean =
            sanitize_assigned_record(&record(Some("person-a"), "2026-09-10T16:00:00Z"), now)
                .unwrap();
        let raw = clean.to_string();
        for private in ["rawResponse", "path", "message", "private"] {
            assert!(!raw.contains(private));
        }
        assert_eq!(clean["personName"], "Alice");
        assert_eq!(clean["tokenSnapshot"]["totalTokens"], 15);
        assert_eq!(clean["tokenSnapshot"]["models"][0]["totalTokens"], 15);
        assert_eq!(clean["quotaAllocation"]["costShare"], 0.25);
        assert_eq!(clean["quotaAllocation"]["allocatedUsedPercent"], 10.0);
    }

    #[test]
    fn daily_percentages_over_100_roundtrip_and_derived_allocation_respects_total() {
        let fixture = Fixture::new();
        let runtime = fixture.0.join("runtime-state.json");
        let input = daily_record(json!(480.0), json!(480.0), json!(0.25), json!(120.0));
        fs::write(
            &runtime,
            serde_json::to_vec(&json!({"comfortFeedback":[input]})).unwrap(),
        )
        .unwrap();

        let mut payload = json!({"_device":"device","_ts":Utc::now().timestamp()});
        attach_local_feedback(&mut payload, &runtime, &[]).unwrap();
        assert_eq!(payload["comfortFeedback"][0]["observedUsedPercent"], 480.0);
        assert_eq!(
            payload["comfortFeedback"][0]["quotaAllocation"]["allocatedUsedPercent"],
            120.0
        );

        let cockpit = fixture.0.join("cockpit");
        fs::create_dir(&cockpit).unwrap();
        fs::write(
            cockpit.join("device.json"),
            serde_json::to_vec(&payload).unwrap(),
        )
        .unwrap();
        let synced = read_synced_feedback(&cockpit).unwrap();
        assert_eq!(synced.len(), 1);
        assert_eq!(synced[0]["observedUsedPercent"], 480.0);
        assert_eq!(synced[0]["quotaAllocation"]["totalUsedPercent"], 480.0);
        assert_eq!(synced[0]["quotaAllocation"]["costShare"], 0.25);
        assert_eq!(synced[0]["quotaAllocation"]["allocatedUsedPercent"], 120.0);
        assert!(
            synced[0]["quotaAllocation"]["allocatedUsedPercent"]
                .as_f64()
                .unwrap()
                <= synced[0]["quotaAllocation"]["totalUsedPercent"]
                    .as_f64()
                    .unwrap()
        );

        let raw = serde_json::to_string(&synced).unwrap();
        for private in ["rawResponse", "path", "message", "private"] {
            assert!(!raw.contains(private));
        }
    }

    #[test]
    fn daily_percentages_reject_negative_nonfinite_and_over_limit_values() {
        let now = DateTime::parse_from_rfc3339("2026-09-11T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        for invalid in [
            json!(-1.0),
            json!("NaN"),
            json!(MAX_DAILY_OBSERVED_PERCENT + 1.0),
        ] {
            assert!(sanitize_assigned_record(
                &daily_record(invalid.clone(), json!(40.0), json!(0.25), json!(10.0)),
                now,
            )
            .is_none());
            assert!(sanitize_assigned_record(
                &daily_record(json!(40.0), invalid.clone(), json!(0.25), json!(10.0)),
                now,
            )
            .is_none());
            assert!(sanitize_assigned_record(
                &daily_record(json!(40.0), json!(40.0), json!(0.25), invalid),
                now,
            )
            .is_none());
        }
        for invalid_share in [json!(-0.01), json!("Infinity"), json!(1.01)] {
            assert!(sanitize_assigned_record(
                &daily_record(json!(40.0), json!(40.0), invalid_share, json!(10.0)),
                now,
            )
            .is_none());
        }
    }

    #[test]
    fn corrupt_primary_uses_backup_and_both_corrupt_block_publish() {
        let fixture = Fixture::new();
        let runtime = fixture.0.join("runtime-state.json");
        fs::write(&runtime, b"not json").unwrap();
        fs::write(
            runtime.with_extension("json.bak"),
            serde_json::to_vec(
                &json!({"comfortFeedback":[record(Some("person-a"), "2026-09-10T16:00:00Z")]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_local_assigned(&runtime, Utc::now())
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        fs::write(runtime.with_extension("json.bak"), b"also corrupt").unwrap();
        assert_eq!(
            read_local_assigned(&runtime, Utc::now()).unwrap_err(),
            "comfort_state_invalid"
        );
    }

    #[test]
    fn attach_preserves_newer_synced_record_and_excludes_unassigned_runtime() {
        let fixture = Fixture::new();
        let runtime = fixture.0.join("runtime-state.json");
        fs::write(
            &runtime,
            serde_json::to_vec(&json!({"comfortFeedback":[
                record(Some("person-a"), "2026-09-10T16:00:00Z"),
                record(None, "2026-09-10T19:00:00Z")
            ]}))
            .unwrap(),
        )
        .unwrap();
        let newer = record(Some("person-a"), "2026-09-10T18:00:00Z");
        let baseline =
            json!({"_device":"device","comfortFeedbackVersion":1,"comfortFeedback":[newer]});
        let mut payload = json!({"_device":"device","_ts":1});
        attach_local_feedback(&mut payload, &runtime, &[baseline]).unwrap();
        assert_eq!(payload["comfortFeedbackVersion"], 1);
        assert_eq!(payload["comfortFeedback"].as_array().unwrap().len(), 1);
        assert_eq!(
            payload["comfortFeedback"][0]["updatedAt"],
            "2026-09-10T18:00:00Z"
        );
        assert_eq!(payload["comfortFeedback"][0]["personId"], "person-a");
    }

    #[test]
    fn unknown_prior_version_fails_closed() {
        let fixture = Fixture::new();
        let runtime = fixture.0.join("runtime-state.json");
        fs::write(
            &runtime,
            serde_json::to_vec(&json!({"comfortFeedback":[]})).unwrap(),
        )
        .unwrap();
        let mut payload = json!({"_device":"device","_ts":1});
        let baseline = json!({"_device":"device","comfortFeedbackVersion":2,"comfortFeedback":[]});
        assert_eq!(
            attach_local_feedback(&mut payload, &runtime, &[baseline]).unwrap_err(),
            "comfort_feedback_version_unsupported"
        );
    }

    #[test]
    fn repository_scan_isolates_malformed_unknown_and_spoofed_files() {
        let fixture = Fixture::new();
        let cockpit = fixture.0.join("cockpit");
        fs::create_dir(&cockpit).unwrap();
        let valid = json!({"_device":"a","_ts":Utc::now().timestamp(),
            "comfortFeedbackVersion":1,"comfortFeedback":[record(Some("person-a"), "2026-09-10T16:00:00Z"),{"bad":true}]});
        fs::write(cockpit.join("a.json"), serde_json::to_vec(&valid).unwrap()).unwrap();
        fs::write(cockpit.join("bad.json"), b"not json").unwrap();
        fs::write(cockpit.join("unknown.json"), serde_json::to_vec(&json!({"_device":"unknown","_ts":1,
            "comfortFeedbackVersion":2,"comfortFeedback":[record(Some("person-b"), "2026-09-10T16:00:00Z")]})).unwrap()).unwrap();
        fs::write(cockpit.join("spoof.json"), serde_json::to_vec(&json!({"_device":"other","_ts":1,
            "comfortFeedbackVersion":1,"comfortFeedback":[record(Some("person-c"), "2026-09-10T16:00:00Z")]})).unwrap()).unwrap();
        let result = read_synced_feedback(&cockpit).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["personId"], "person-a");
    }

    #[cfg(unix)]
    #[test]
    fn repository_scan_rejects_cockpit_symlink() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let real = fixture.0.join("real");
        fs::create_dir(&real).unwrap();
        let linked = fixture.0.join("cockpit");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            read_synced_feedback(&linked).unwrap_err(),
            "unsafe_comfort_sync_path"
        );
    }
}

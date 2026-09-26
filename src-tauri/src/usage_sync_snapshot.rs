//! Aggregates only. Project names, paths, session IDs and raw input never enter the wire format.
use crate::{
    codex_project_usage::ProjectUsageSnapshot,
    tokei_usage::{self, Metrics, UsagePeriod},
};
use chrono::{Datelike, Duration, Local, NaiveDate, Utc};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn zero() -> Metrics {
    Metrics {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: Some(0.0),
    }
}
fn add(target: &mut Metrics, value: &Metrics) -> Result<(), String> {
    target.input_tokens = target
        .input_tokens
        .checked_add(value.input_tokens)
        .ok_or("usage_overflow")?;
    target.cached_input_tokens = target
        .cached_input_tokens
        .checked_add(value.cached_input_tokens)
        .ok_or("usage_overflow")?;
    target.output_tokens = target
        .output_tokens
        .checked_add(value.output_tokens)
        .ok_or("usage_overflow")?;
    target.reasoning_tokens = target
        .reasoning_tokens
        .checked_add(value.reasoning_tokens)
        .ok_or("usage_overflow")?;
    target.total_tokens = target
        .total_tokens
        .checked_add(value.total_tokens)
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or("usage_overflow")?;
    target.estimated_cost_usd = match (target.estimated_cost_usd, value.estimated_cost_usd) {
        (Some(a), Some(b)) if (a + b).is_finite() => Some(a + b),
        _ => None,
    };
    Ok(())
}
fn combine<'a>(days: impl Iterator<Item = &'a UsagePeriod>) -> Result<UsagePeriod, String> {
    let mut result = UsagePeriod {
        start: None,
        end: None,
        metrics: zero(),
        models: Vec::new(),
    };
    let mut models = BTreeMap::new();
    for day in days {
        add(&mut result.metrics, &day.metrics)?;
        for model in &day.models {
            let row = models.entry(model.id.clone()).or_insert_with(|| {
                let mut row = model.clone();
                row.metrics = zero();
                row
            });
            add(&mut row.metrics, &model.metrics)?;
        }
    }
    result.models = models.into_values().collect();
    Ok(result)
}

fn gpt_identity(id: &str) -> Option<(String, bool)> {
    let lowercase = id.to_ascii_lowercase();
    let without_tokei = lowercase.strip_prefix("tokei-name:").unwrap_or(&lowercase);
    let normalized = without_tokei
        .strip_prefix("openai/")
        .unwrap_or(without_tokei);
    let rest = normalized.strip_prefix("gpt-")?;
    let generation_len = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit() || *ch == '.')
        .map(|(index, ch)| index + ch.len_utf8())
        .last()?;
    let generation = &rest[..generation_len];
    if generation.starts_with('.')
        || generation.ends_with('.')
        || generation.split('.').any(|part| part.is_empty())
    {
        return None;
    }
    let suffix = &rest[generation_len..];
    if !suffix.is_empty() && !suffix.starts_with('-') {
        return None;
    }
    Some((format!("gpt-{generation}"), !suffix.is_empty()))
}

fn refines_generation_identity(previous: &UsagePeriod, current: &UsagePeriod) -> bool {
    if previous.metrics.total_tokens != current.metrics.total_tokens
        || current.models.is_empty()
        || current.models.iter().try_fold(0_u64, |sum, model| {
            sum.checked_add(model.metrics.total_tokens)
        }) != Some(current.metrics.total_tokens)
        || current.models.iter().any(|model| model.id == "unknown")
    {
        return false;
    }
    let generic_generations: BTreeSet<_> = previous
        .models
        .iter()
        .filter_map(|model| gpt_identity(&model.id))
        .filter_map(|(generation, variant)| (!variant).then_some(generation))
        .collect();
    current.models.iter().any(|model| {
        gpt_identity(&model.id).is_some_and(|(generation, variant)| {
            variant && generic_generations.contains(&generation)
        })
    })
}

fn wire_metrics(m: &Metrics, ledger: bool) -> Value {
    json!({"in": if ledger {m.input_tokens + m.cached_input_tokens} else {m.input_tokens}, "cached":m.cached_input_tokens,"out":m.output_tokens,"reason":m.reasoning_tokens,"cost":m.estimated_cost_usd})
}
fn wire_period(day: &UsagePeriod, ledger: bool) -> Value {
    let mut result = wire_metrics(&day.metrics, ledger);
    if ledger {
        let mut models = Map::new();
        for model in &day.models {
            let mut row = json!({"in":model.metrics.input_tokens,"cr":model.metrics.cached_input_tokens,"cw":0,"out":model.metrics.output_tokens,"reason":model.metrics.reasoning_tokens,"cost":model.metrics.estimated_cost_usd});
            row["name"] = json!(model.name);
            models.insert(model.id.clone(), row);
        }
        result["models"] = Value::Object(models);
    } else {
        result["models"] = Value::Array(day.models.iter().map(|model| json!({
            "model_id":model.id,"name":model.name,"in":model.metrics.input_tokens,"cr":model.metrics.cached_input_tokens,
            "out":model.metrics.output_tokens,"reason":model.metrics.reasoning_tokens,"cost":model.metrics.estimated_cost_usd
        })).collect());
    }
    result
}

/// Preserve whole historical days, never add old and rescanned copies of the same day.
/// A partial/lower rescan cannot shrink a previous day's observed total.
pub fn build(
    device_id: &str,
    collected: &ProjectUsageSnapshot,
    baselines: &[Value],
) -> Result<Value, String> {
    build_at(device_id, collected, baselines, Local::now().date_naive())
}
pub(crate) fn build_at(
    device_id: &str,
    collected: &ProjectUsageSnapshot,
    baselines: &[Value],
    today: NaiveDate,
) -> Result<Value, String> {
    let mut days: BTreeMap<String, UsagePeriod> = BTreeMap::new();
    let mut native_days: BTreeSet<String> = BTreeSet::new();
    let mut old_ranges: BTreeMap<String, UsagePeriod> = BTreeMap::new();
    for value in baselines {
        if value["_device"].as_str() != Some(device_id) {
            continue;
        }
        if let Some(device) = tokei_usage::parse_device(value, device_id, None) {
            for (date, day) in device.daily {
                if date > today.to_string() {
                    continue;
                }
                let is_native = value["_cockpit"]["nativeDays"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|v| v.as_str() == Some(date.as_str())));
                if days
                    .get(&date)
                    .is_none_or(|old| day.metrics.total_tokens > old.metrics.total_tokens)
                {
                    if is_native {
                        native_days.insert(date.clone());
                    } else {
                        native_days.remove(&date);
                    }
                    days.insert(date, day);
                } else if !is_native
                    && days
                        .get(&date)
                        .is_some_and(|old| old.metrics.total_tokens == day.metrics.total_tokens)
                {
                    native_days.remove(&date);
                }
            }
            for (key, range) in device.ranges {
                if old_ranges
                    .get(&key)
                    .is_none_or(|old| range.metrics.total_tokens > old.metrics.total_tokens)
                {
                    old_ranges.insert(key, range);
                }
            }
        }
    }
    let mut native: BTreeMap<String, Vec<&UsagePeriod>> = BTreeMap::new();
    for project in &collected.projects {
        for (date, day) in &project.daily {
            if NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .is_ok_and(|d| d.to_string() == *date && d <= today)
            {
                native.entry(date.clone()).or_default().push(day);
            }
        }
    }
    let mut retained_days = 0;
    let mut retained_mismatch = false;
    for (date, records) in native {
        let day = combine(records.into_iter())?;
        let mut identity_refined = false;
        // A price-catalog rescan can improve individual models even when another
        // model keeps the whole day's cost unknown. Never require full coverage
        // before publishing the known portion, and never sum duplicate rescans.
        if let Some(old) = days.get_mut(&date) {
            if old.metrics.total_tokens == day.metrics.total_tokens {
                for model in &day.models {
                    if let Some(previous) = old.models.iter_mut().find(|m| m.id == model.id) {
                        if previous.metrics.input_tokens == model.metrics.input_tokens
                            && previous.metrics.cached_input_tokens
                                == model.metrics.cached_input_tokens
                            && previous.metrics.output_tokens == model.metrics.output_tokens
                            && model.metrics.estimated_cost_usd.is_some()
                        {
                            previous.metrics.estimated_cost_usd = model.metrics.estimated_cost_usd;
                        }
                    }
                }
                if day.metrics.estimated_cost_usd.is_some() {
                    old.metrics.estimated_cost_usd = day.metrics.estimated_cost_usd;
                }
                // A legacy range/ledger may contain only a generation label. If
                // the native JSONL rescan covers the same full token total and
                // carries source model IDs, replace only the model breakdown.
                // Never synthesize Sol/Luna/Astra from a generation-only row.
                if refines_generation_identity(old, &day) {
                    old.models = day.models.clone();
                    native_days.insert(date.clone());
                    identity_refined = true;
                }
            }
        }
        if days.get(&date).is_none_or(|old| {
            (native_days.contains(&date)
                || (collected.status == "ready" && collected.warnings.is_empty()))
                && !(old.metrics.estimated_cost_usd.is_some()
                    && day.metrics.estimated_cost_usd.is_none())
                && (day.metrics.total_tokens > old.metrics.total_tokens
                    || (day.metrics.total_tokens == old.metrics.total_tokens
                        && old.metrics.estimated_cost_usd.is_none()
                        && day.metrics.estimated_cost_usd.is_some()))
        }) {
            native_days.insert(date.clone());
            days.insert(date, day);
        } else if !identity_refined {
            retained_days += 1;
            retained_mismatch |= days
                .get(&date)
                .is_some_and(|old| old.metrics.total_tokens != day.metrics.total_tokens);
        }
    }
    if days.is_empty() {
        return Err("collector_no_dated_usage".into());
    }
    if days.len() > 3660 {
        return Err("history_limit".into());
    }
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let month = today.with_day(1).ok_or("invalid_date")?;
    let next_month = if month.month() == 12 {
        NaiveDate::from_ymd_opt(month.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(month.year(), month.month() + 1, 1)
    }
    .ok_or("invalid_date")?;
    let specs = [
        ("today", Some(today), Some(today + Duration::days(1))),
        ("yesterday", Some(today - Duration::days(1)), Some(today)),
        ("week", Some(monday), Some(monday + Duration::days(7))),
        ("month", Some(month), Some(next_month)),
        ("all", None, None),
    ];
    let mut ranges = Map::new();
    let mut bounds = Map::new();
    for (key, start, end) in specs {
        let start = start.map(|d| d.to_string());
        let end = end.map(|d| d.to_string());
        let matching: Vec<_> = days
            .iter()
            .filter(|(date, _)| {
                start.as_ref().is_none_or(|s| *date >= s) && end.as_ref().is_none_or(|e| *date < e)
            })
            .map(|(_, day)| day)
            .collect();
        // Do not turn an absent day into a zero-usage observation.
        let old = old_ranges
            .get(key)
            .filter(|old| old.start == start && old.end == end);
        if matching.is_empty() && old.is_none() {
            continue;
        }
        let mut range = combine(matching.into_iter())?;
        if let Some(old) = old.filter(|old| old.metrics.total_tokens >= range.metrics.total_tokens)
        {
            range = old.clone();
        }
        bounds.insert(key.into(), json!({"start":start,"end":end}));
        ranges.insert(key.into(), wire_period(&range, false));
    }
    let ledger: Map<_, _> = days
        .iter()
        .map(|(date, day)| (date.clone(), wire_period(day, true)))
        .collect();
    let status = if collected.status == "ready" && retained_mismatch {
        "partial"
    } else {
        &collected.status
    };
    let payload = json!({"_device":device_id,"_ts":Utc::now().timestamp(),"_range_bounds":bounds,
        "codex":{"ranges":ranges},"_ledger":{"v":1,"tools":{"codex":ledger}},
        "_cockpit":{"schemaVersion":1,"collectedAt":collected.updated_at,"status":status,"retainedDays":retained_days,"nativeDays":native_days}});
    if serde_json::to_vec(&payload)
        .map_err(|_| "snapshot_invalid")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("snapshot_too_large".into());
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_project_usage::ProjectUsage;
    fn fixture(tokens: u64) -> ProjectUsageSnapshot {
        let m = Metrics {
            input_tokens: tokens,
            total_tokens: tokens,
            estimated_cost_usd: Some(1.0),
            ..zero()
        };
        ProjectUsageSnapshot {
            device_id: None,
            updated_at: "2026-09-10T07:00:00Z".into(),
            status: "partial".into(),
            coverage: "local".into(),
            scanned_files: 1,
            pricing_source: "local".into(),
            pricing_updated_at: None,
            warnings: vec![],
            peer_tasks: vec![],
            tasks: vec![crate::codex_project_usage::TaskUsage {
                id: "private-task-id".into(),
                name: "private-task-title".into(),
                project_name: None,
                parent_id: None,
                root_id: None,
                relation: crate::codex_project_usage::TaskRelation::Root,
                agent_nickname: None,
                agent_role: None,
                daily: BTreeMap::new(),
            }],
            task_metadata_coverage: "complete".into(),
            projects: vec![ProjectUsage {
                id: "private-project-id".into(),
                name: "/private/project/path".into(),
                daily: BTreeMap::from([(
                    "2026-09-10".into(),
                    UsagePeriod {
                        start: None,
                        end: None,
                        metrics: m.clone(),
                        models: vec![crate::tokei_usage::ModelUsage {
                            id: "gpt-6".into(),
                            name: "GPT-6".into(),
                            metrics: m,
                        }],
                    },
                )]),
            }],
        }
    }
    #[test]
    fn task_sync_is_explicit_allowlisted_and_size_bounded() {
        let mut source = fixture(100);
        source.tasks[0].project_name = Some("/private/project".into());
        source.tasks[0].agent_role = Some("private role".into());
        source.tasks[0].daily = source.projects[0].daily.clone();
        let mut payload = json!({});
        crate::task_sync::attach(&mut payload, &source);
        assert_eq!(
            payload["taskUsage"]["tasks"][0]["name"],
            "private-task-title"
        );
        assert_eq!(
            payload["taskUsage"]["tasks"][0]["daily"]["2026-09-10"]["totalTokens"],
            100
        );
        assert!(!payload.to_string().contains("/private/project"));
        assert!(!payload.to_string().contains("private role"));
        let mut full = json!({"existing": "x".repeat(900_000)});
        crate::task_sync::attach(&mut full, &source);
        assert_eq!(full["taskUsage"]["partial"], true);
        assert_eq!(full["taskUsage"]["tasks"], json!([]));
    }
    #[test]
    fn wire_roundtrip_is_aggregate_only_and_rescans_do_not_double_count() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let first = build_at("device", &fixture(100), &[], date).unwrap();
        let second = build_at("device", &fixture(50), std::slice::from_ref(&first), date).unwrap();
        let parsed = tokei_usage::parse_device(&second, "device", None).unwrap();
        assert_eq!(parsed.daily["2026-09-10"].metrics.total_tokens, 100);
        assert_eq!(
            parsed.daily["2026-09-10"].models[0].metrics.total_tokens,
            100
        );
        let raw = second.to_string();
        assert!(!raw.contains("private-project"));
        assert!(!raw.contains("private-task"));
        assert!(!raw.contains("/private"));
        let partial =
            build_at("device", &fixture(150), std::slice::from_ref(&first), date).unwrap();
        assert_eq!(
            tokei_usage::parse_device(&partial, "device", None)
                .unwrap()
                .daily["2026-09-10"]
                .metrics
                .total_tokens,
            150
        );
        let mut legacy = first.clone();
        legacy.as_object_mut().unwrap().remove("_cockpit");
        let preserved = build_at("device", &fixture(150), &[legacy], date).unwrap();
        assert_eq!(
            tokei_usage::parse_device(&preserved, "device", None)
                .unwrap()
                .daily["2026-09-10"]
                .metrics
                .total_tokens,
            100
        );
        let mut complete = fixture(150);
        complete.status = "ready".into();
        let third = build_at("device", &complete, &[first], date).unwrap();
        assert_eq!(
            tokei_usage::parse_device(&third, "device", None)
                .unwrap()
                .daily["2026-09-10"]
                .metrics
                .total_tokens,
            150
        );
    }
    #[test]
    fn cached_model_tokens_survive_ledger_roundtrip() {
        let mut source = fixture(100);
        let day = source.projects[0].daily.get_mut("2026-09-10").unwrap();
        day.metrics.cached_input_tokens = 40;
        day.metrics.total_tokens = 140;
        day.models[0].metrics = day.metrics.clone();
        let value = build_at(
            "device",
            &source,
            &[],
            NaiveDate::from_ymd_opt(2026, 9, 10).unwrap(),
        )
        .unwrap();
        let result = tokei_usage::parse_device(&value, "device", None).unwrap();
        for metrics in [
            &result.daily["2026-09-10"].metrics,
            &result.daily["2026-09-10"].models[0].metrics,
        ] {
            assert_eq!(metrics.input_tokens, 100);
            assert_eq!(metrics.cached_input_tokens, 40);
            assert_eq!(metrics.total_tokens, 140);
        }
    }
    #[test]
    fn native_rescan_refines_generation_rows_without_guessing_missing_variants() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let baseline = build_at("device", &fixture(100), &[], date).unwrap();
        let mut scan = fixture(100);
        let day = scan.projects[0].daily.get_mut("2026-09-10").unwrap();
        let model = day.models.remove(0);
        day.models = [
            ("gpt-6-astra", 40, 0.4),
            ("gpt-5.6-sol", 35, 0.35),
            ("gpt-5.6-luna", 25, 0.25),
        ]
        .into_iter()
        .map(|(id, tokens, cost)| crate::tokei_usage::ModelUsage {
            id: id.into(),
            name: id.into(),
            metrics: Metrics {
                input_tokens: tokens,
                total_tokens: tokens,
                estimated_cost_usd: Some(cost),
                ..model.metrics.clone()
            },
        })
        .collect();
        let refined = build_at("device", &scan, &[baseline], date).unwrap();
        let parsed = tokei_usage::parse_device(&refined, "device", None).unwrap();
        let ids: BTreeSet<_> = parsed.daily["2026-09-10"]
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(
            ids,
            BTreeSet::from(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"])
        );
        assert_eq!(
            parsed.daily["2026-09-10"]
                .models
                .iter()
                .map(|model| model.metrics.total_tokens)
                .sum::<u64>(),
            parsed.daily["2026-09-10"].metrics.total_tokens
        );

        let generation_only = build_at("device", &fixture(100), &[], date).unwrap();
        let unchanged = build_at("device", &fixture(100), &[generation_only], date).unwrap();
        let parsed = tokei_usage::parse_device(&unchanged, "device", None).unwrap();
        assert_eq!(parsed.daily["2026-09-10"].models[0].id, "gpt-6");
    }
    #[test]
    fn catalog_rescan_updates_known_models_without_requiring_full_day_cost() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let mut scan = fixture(100);
        let day = scan.projects[0].daily.get_mut("2026-09-10").unwrap();
        day.metrics.estimated_cost_usd = None;
        day.models[0].metrics.estimated_cost_usd = None;
        let old = build_at("device", &scan, &[], date).unwrap();
        scan.projects[0].daily.get_mut("2026-09-10").unwrap().models[0]
            .metrics
            .estimated_cost_usd = Some(2.0);
        let next = build_at("device", &scan, &[old], date).unwrap();
        let parsed = tokei_usage::parse_device(&next, "device", None).unwrap();
        assert_eq!(parsed.daily["2026-09-10"].metrics.total_tokens, 100);
        assert_eq!(
            parsed.daily["2026-09-10"].models[0]
                .metrics
                .estimated_cost_usd,
            Some(2.0)
        );
        assert_eq!(parsed.daily["2026-09-10"].metrics.estimated_cost_usd, None);
    }
    #[test]
    fn a_complete_rescan_cannot_erase_verified_historical_cost() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let baseline = build_at("device", &fixture(100), &[], date).unwrap();
        let mut scan = fixture(200);
        scan.status = "ready".into();
        let day = scan.projects[0].daily.get_mut("2026-09-10").unwrap();
        day.metrics.estimated_cost_usd = None;
        day.models[0].metrics.estimated_cost_usd = None;
        let result = build_at("device", &scan, &[baseline], date).unwrap();
        let device = tokei_usage::parse_device(&result, "device", None).unwrap();
        assert_eq!(
            device.daily["2026-09-10"].metrics.estimated_cost_usd,
            Some(1.0)
        );
        assert_eq!(device.daily["2026-09-10"].metrics.total_tokens, 100);
    }
    #[test]
    fn preserves_old_days_and_drops_foreign_payload_fields() {
        let date = NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
        let old = json!({"_device":"device","_ts":1,"secret":"never-sync","_ledger":{"tools":{"codex":{"2026-08-01":{"in":300,"cached":100,"out":10,"cost":2,"models":{}}}}}});
        let result = build_at("device", &fixture(50), &[old], date).unwrap();
        let parsed = tokei_usage::parse_device(&result, "device", None).unwrap();
        assert_eq!(parsed.daily["2026-08-01"].metrics.total_tokens, 310);
        assert!(!result.to_string().contains("never-sync"));
        assert!(result["codex"]["ranges"]["yesterday"].is_null());
    }
}

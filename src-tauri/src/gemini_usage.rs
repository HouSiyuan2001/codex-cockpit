//! Local Antigravity desktop and CLI usage. Only model counters, timestamps,
//! and task metadata are projected from Antigravity's files.
use crate::claude_usage::{
    aggregate_usage, ClaudeModelPrice, ClaudePrice, ClaudeUsageReport, UsageEntry,
};
use crate::usage_time;
use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOKENS_PER_STEP: u64 = 100_000_000;

// Gemini Developer API Standard text rates in USD per million tokens.
// https://aistudio.google.com/docs/pricing
const PRICE_TABLE_CHECKED_AT: &str = "2026-11-26";

struct ModelPricing {
    id: &'static str,
    name: &'static str,
    standard: ClaudePrice,
    launch: Option<ClaudePrice>,
}

const fn price(input: f64, cache_read: f64, output: f64) -> ClaudePrice {
    ClaudePrice {
        input,
        cache_read,
        output,
        cache_write_5m: 0.0,
        cache_write_1h: 0.0,
    }
}

const MODELS: &[ModelPricing] = &[
    ModelPricing {
        id: "gemini-4-carbon",
        name: "Gemini 4 Carbon",
        standard: price(4.0, 0.20, 20.0),
        launch: Some(price(2.0, 0.10, 10.0)),
    },
    ModelPricing {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        standard: price(4.0, 0.20, 20.0),
        launch: Some(price(2.0, 0.10, 10.0)),
    },
    ModelPricing {
        id: "gemini-4-neon",
        name: "Gemini 4 Neon",
        standard: price(3.0, 0.15, 15.0),
        launch: None,
    },
    ModelPricing {
        id: "gemini-4-hydrogen",
        name: "Gemini 4 Hydrogen",
        standard: price(1.50, 0.075, 7.50),
        launch: None,
    },
];

impl ModelPricing {
    fn rates_on(&self, day: NaiveDate) -> ClaudePrice {
        // Apply the published date using the same calendar as the usage report.
        let increase_day = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap();
        match self.launch {
            Some(launch) if day < increase_day => launch,
            _ => self.standard,
        }
    }
}

fn model_usage(entry: &UsageEntry) -> (String, String, Option<f64>) {
    let id = match entry.model.rsplit_once('-') {
        Some((base, "low" | "medium" | "high" | "xhigh")) => base,
        _ => entry.model.as_str(),
    };
    let Some(model) = MODELS.iter().find(|model| model.id == id) else {
        return (entry.model.clone(), entry.model.clone(), None);
    };
    let rates = model.rates_on(usage_time::calendar_day(&entry.at));
    let cost = (entry.input as f64 * rates.input
        + entry.cache_read as f64 * rates.cache_read
        + entry.output as f64 * rates.output)
        / 1_000_000.0;
    (model.id.to_owned(), model.name.to_owned(), Some(cost))
}

#[derive(Deserialize)]
struct Step {
    step_index: u64,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    created_at: String,
    model: String,
    input_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    output_tokens: u64,
}

fn usage_entry(line: &str, session: &str, project: Option<&str>) -> Option<UsageEntry> {
    let step: Step = serde_json::from_str(line).ok()?;
    let counts = [
        step.input_tokens,
        step.cache_read_tokens,
        step.output_tokens,
    ];
    if step.kind != "PLANNER_RESPONSE"
        || step.status != "DONE"
        || step.model.trim().is_empty()
        || step.model.len() > 120
        || counts.iter().any(|count| *count > MAX_TOKENS_PER_STEP)
        || counts.iter().all(|count| *count == 0)
    {
        return None;
    }
    Some(UsageEntry {
        key: format!("{session}/{}", step.step_index),
        at: DateTime::parse_from_rfc3339(&step.created_at).ok()?,
        model: step.model,
        input: step.input_tokens,
        cache_write_5m: 0,
        cache_write_1h: 0,
        cache_read: step.cache_read_tokens,
        output: step.output_tokens,
        fast: false,
        us_geo: false,
        session: Some(session.to_owned()),
        cwd: project.map(str::to_owned),
    })
}

fn read_root(root: &Path, entries: &mut Vec<UsageEntry>, titles: &mut HashMap<String, String>) {
    let Ok(sessions) = fs::read_dir(root.join("brain")) else {
        return;
    };
    let summaries = Connection::open_with_flags(
        root.join("conversation_summaries.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok();
    let mut metadata = summaries.as_ref().and_then(|db| {
        db.prepare(
            "SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?1",
        )
        .ok()
    });
    for session in sessions.flatten() {
        if !session.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = session.file_name();
        let Some(id) = name
            .to_str()
            .filter(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        else {
            continue;
        };
        let transcript = session
            .path()
            .join(".system_generated/logs/transcript.jsonl");
        if !transcript
            .symlink_metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= MAX_TRANSCRIPT_BYTES)
        {
            continue;
        }
        let Ok(file) = File::open(&transcript) else {
            continue;
        };
        let (title, workspace) = metadata
            .as_mut()
            .and_then(|stmt| {
                stmt.query_row([id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })
                .ok()
            })
            .unwrap_or_default();
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            titles
                .entry(id.to_owned())
                .or_insert_with(|| title.chars().take(160).collect());
        }
        let workspace = workspace
            .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
            .and_then(|uris| uris.into_iter().next())
            .and_then(|uri| reqwest::Url::parse(&uri).ok()?.to_file_path().ok());
        let project = workspace.as_ref().and_then(|path| path.to_str());
        entries.extend(
            BufReader::new(file.take(MAX_TRANSCRIPT_BYTES))
                .lines()
                .map_while(Result::ok)
                .filter_map(|line| usage_entry(&line, id, project)),
        );
    }
}

pub(crate) fn read_usage(days: u32) -> ClaudeUsageReport {
    let now = Utc::now();
    let mut entries = Vec::new();
    let mut titles = HashMap::new();
    if let Some(base) = dirs::home_dir().map(|home| home.join(".gemini")) {
        for name in ["antigravity", "antigravity-cli"] {
            read_root(&base.join(name), &mut entries, &mut titles);
        }
    }
    let latest_activity_at = entries
        .iter()
        .map(|entry| entry.at)
        .max()
        .map(|at| at.to_rfc3339());
    let today = usage_time::calendar_day(&now);
    ClaudeUsageReport {
        status: if entries.is_empty() {
            "unavailable"
        } else {
            "ok"
        },
        observed_at: now.to_rfc3339(),
        latest_activity_at,
        price_checked_at: PRICE_TABLE_CHECKED_AT,
        days: aggregate_usage(entries, &titles, today, days, model_usage),
        prices: MODELS
            .iter()
            .map(|model| ClaudeModelPrice {
                id: model.id.to_owned(),
                name: model.name.to_owned(),
                price: model.rates_on(today),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_completed_calls_once_and_preserves_unknown_cost() {
        let line = r#"{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","model":"gemini-test","created_at":"2026-11-26T17:10:00Z","input_tokens":100,"output_tokens":10,"cache_read_tokens":50,"content":"ignored"}"#;
        let entry = || usage_entry(line, "session", Some("/projects/demo")).unwrap();
        assert!(usage_entry(&line.replace("DONE", "RUNNING"), "session", None).is_none());
        let date = usage_time::calendar_day(&entry().at);
        let days = aggregate_usage(
            vec![entry(), entry()],
            &HashMap::new(),
            date,
            1,
            model_usage,
        );
        assert_eq!(
            (
                days[0].input_tokens,
                days[0].cache_read_tokens,
                days[0].output_tokens
            ),
            (100, 50, 10)
        );
        assert_eq!(days[0].requests, 1);
        assert_eq!(days[0].unpriced_requests, 1);
        assert_eq!(days[0].tasks[0].cost_usd, None);
        assert_eq!(days[0].projects[0].name, "demo");
    }

    #[test]
    fn prices_logged_carbon_calls_at_each_days_rates() {
        let line = r#"{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","model":"gemini-4-carbon-medium","created_at":"2026-11-30T23:59:59+08:00","input_tokens":1000000,"cache_read_tokens":2000000,"output_tokens":100000}"#;
        let before = usage_entry(line, "session", Some("/projects/demo")).unwrap();
        let after = usage_entry(
            &line
                .replace(r#""step_index":1"#, r#""step_index":2"#)
                .replace("11-30T23:59:59", "12-01T00:00:00"),
            "session",
            Some("/projects/demo"),
        )
        .unwrap();
        let today = usage_time::calendar_day(&after.at);
        let days = aggregate_usage(vec![before, after], &HashMap::new(), today, 2, model_usage);
        for (day, expected) in days.iter().zip([3.2, 6.4]) {
            assert_eq!(day.unpriced_requests, 0);
            assert_eq!(day.models[0].id, "gemini-4-carbon");
            assert_eq!(day.models[0].name, "Gemini 4 Carbon");
            for cost in [
                day.cost_usd,
                day.tasks[0].cost_usd.unwrap(),
                day.projects[0].cost_usd.unwrap(),
            ] {
                assert!((cost - expected).abs() < 1e-10);
            }
        }
        assert_eq!(days.len(), 2);
    }
}

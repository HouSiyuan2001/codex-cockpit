//! Read-only local Claude Code usage.
//!
//! Claude Code writes one JSONL transcript per session under
//! `<config>/projects/**`. Only the per-message `usage`, `model`, `speed`,
//! `inference_geo` and timestamp fields are read here; message bodies are never
//! retained, logged or returned. Costs are API-equivalent estimates from the
//! public price list, not a subscription bill.
use crate::usage_time;
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Anthropic API prices in USD per million tokens, checked on 2026-11-09
/// against https://platform.claude.com/docs/en/about-claude/pricing.
pub const PRICE_TABLE_CHECKED_AT: &str = "2026-11-09";
const MAX_HISTORY_DAYS: u32 = 400;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePrice {
    pub input: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
    pub output: f64,
}

const fn price(
    input: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
    output: f64,
) -> ClaudePrice {
    ClaudePrice {
        input,
        cache_write_5m,
        cache_write_1h,
        cache_read,
        output,
    }
}

struct ModelPricing {
    id: &'static str,
    name: &'static str,
    standard: ClaudePrice,
    /// Haiku 5.5 bills a whole request at this tier when its prompt exceeds 100K tokens.
    long_prompt: Option<ClaudePrice>,
    /// Fast mode multiplies every token category.
    fast_multiplier: Option<f64>,
    /// `inference_geo: "us"` costs 1.1x on Claude 4.6 and later.
    us_geo_premium: bool,
}

const LONG_PROMPT_THRESHOLD: u64 = 100_000;

const MODELS: &[ModelPricing] = &[
    ModelPricing {
        id: "claude-fable-5-2",
        name: "Fable 5.2",
        standard: price(8.0, 10.0, 16.0, 0.20, 40.0),
        long_prompt: None,
        fast_multiplier: Some(2.0),
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-mythos-5-2",
        name: "Mythos 5.2",
        standard: price(8.0, 10.0, 16.0, 0.20, 40.0),
        long_prompt: None,
        fast_multiplier: Some(2.0),
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-fable-5-1",
        name: "Fable 5.1",
        standard: price(10.0, 12.5, 20.0, 0.25, 50.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-mythos-5-1",
        name: "Mythos 5.1",
        standard: price(10.0, 12.5, 20.0, 0.25, 50.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-fable-5",
        name: "Fable 5",
        standard: price(10.0, 12.5, 20.0, 1.0, 50.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-mythos-5",
        name: "Mythos 5",
        standard: price(10.0, 12.5, 20.0, 1.0, 50.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-5-5",
        name: "Opus 5.5",
        standard: price(4.0, 5.0, 8.0, 0.20, 20.0),
        long_prompt: None,
        fast_multiplier: Some(2.0),
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-5",
        name: "Opus 5",
        standard: price(5.0, 6.25, 10.0, 0.50, 25.0),
        long_prompt: None,
        fast_multiplier: Some(2.0),
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        standard: price(5.0, 6.25, 10.0, 0.50, 25.0),
        long_prompt: None,
        fast_multiplier: Some(2.0),
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-4-7",
        name: "Opus 4.7",
        standard: price(5.0, 6.25, 10.0, 0.50, 25.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        standard: price(5.0, 6.25, 10.0, 0.50, 25.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        standard: price(5.0, 6.25, 10.0, 0.50, 25.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
    ModelPricing {
        id: "claude-opus-4-1",
        name: "Opus 4.1",
        standard: price(15.0, 18.75, 30.0, 1.50, 75.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
    ModelPricing {
        id: "claude-opus-4",
        name: "Opus 4",
        standard: price(15.0, 18.75, 30.0, 1.50, 75.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
    ModelPricing {
        id: "claude-sonnet-5-5",
        name: "Sonnet 5.5",
        standard: price(2.0, 2.5, 4.0, 0.10, 10.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-sonnet-5",
        name: "Sonnet 5",
        standard: price(2.0, 2.5, 4.0, 0.20, 10.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        standard: price(3.0, 3.75, 6.0, 0.30, 15.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-sonnet-4-5",
        name: "Sonnet 4.5",
        standard: price(3.0, 3.75, 6.0, 0.30, 15.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
    ModelPricing {
        id: "claude-sonnet-4",
        name: "Sonnet 4",
        standard: price(3.0, 3.75, 6.0, 0.30, 15.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
    ModelPricing {
        id: "claude-haiku-5-5",
        name: "Haiku 5.5",
        standard: price(0.10, 0.125, 0.20, 0.01, 0.50),
        long_prompt: Some(price(0.50, 0.625, 1.0, 0.05, 2.50)),
        fast_multiplier: None,
        us_geo_premium: true,
    },
    ModelPricing {
        id: "claude-haiku-4-5",
        name: "Haiku 4.5",
        standard: price(1.0, 1.25, 2.0, 0.10, 5.0),
        long_prompt: None,
        fast_multiplier: None,
        us_geo_premium: false,
    },
];

/// Exact id, an 8-digit snapshot suffix, or a client-side context tag such as `[1m]`.
fn find_model(model: &str) -> Option<&'static ModelPricing> {
    let model = model.trim().to_ascii_lowercase();
    let model = model.strip_prefix("anthropic.").unwrap_or(&model);
    MODELS
        .iter()
        .filter(|entry| {
            let Some(rest) = model.strip_prefix(entry.id) else {
                return false;
            };
            rest.is_empty()
                || rest.starts_with('[')
                || rest.starts_with('@')
                || rest.strip_prefix('-').is_some_and(|date| {
                    date.len() >= 8 && date[..8].bytes().all(|b| b.is_ascii_digit())
                })
        })
        .max_by_key(|entry| entry.id.len())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelPrice {
    pub id: String,
    pub name: String,
    pub price: ClaudePrice,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelUsage {
    pub id: String,
    pub name: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    /// `None` when the model is missing from the price list; never coerced to zero.
    pub cost_usd: Option<f64>,
    /// For a task row: the project folder name it ran in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDailyUsage {
    pub local_date: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub unpriced_requests: u64,
    pub models: Vec<ClaudeModelUsage>,
    /// Claude Code sessions, titled as in Claude Code; `name` is empty when untitled.
    pub tasks: Vec<ClaudeModelUsage>,
    /// Working folders; `id` is the local path and never leaves this device.
    pub projects: Vec<ClaudeModelUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageReport {
    pub status: &'static str,
    pub observed_at: String,
    pub latest_activity_at: Option<String>,
    pub price_checked_at: &'static str,
    pub days: Vec<ClaudeDailyUsage>,
    pub prices: Vec<ClaudeModelPrice>,
}

#[derive(Debug, Clone)]
struct UsageEntry {
    key: String,
    at: DateTime<FixedOffset>,
    model: String,
    input: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
    output: u64,
    fast: bool,
    us_geo: bool,
    session: Option<String>,
    cwd: Option<String>,
}

impl UsageEntry {
    fn cache_write(&self) -> u64 {
        self.cache_write_5m + self.cache_write_1h
    }

    fn cost_usd(&self) -> Option<f64> {
        let pricing = find_model(&self.model)?;
        let prompt = self.input + self.cache_write() + self.cache_read;
        let rates = match pricing.long_prompt {
            Some(long) if prompt > LONG_PROMPT_THRESHOLD => long,
            _ => pricing.standard,
        };
        let mut cost = (self.input as f64 * rates.input
            + self.cache_write_5m as f64 * rates.cache_write_5m
            + self.cache_write_1h as f64 * rates.cache_write_1h
            + self.cache_read as f64 * rates.cache_read
            + self.output as f64 * rates.output)
            / 1_000_000.0;
        if self.fast {
            cost *= pricing.fast_multiplier.unwrap_or(1.0);
        }
        if self.us_geo && pricing.us_geo_premium {
            cost *= 1.1;
        }
        Some(cost)
    }
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    uuid: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawTitle {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
}

/// Session titles are short metadata lines, separate from the conversation.
fn parse_title(line: &str) -> Option<(String, String)> {
    if !line.contains("\"custom-title\"") {
        return None;
    }
    let raw: RawTitle = serde_json::from_str(line).ok()?;
    if raw.kind.as_deref() != Some("custom-title") {
        return None;
    }
    let title: String = raw.custom_title?.trim().chars().take(120).collect();
    (!title.is_empty()).then_some((raw.session_id?, title))
}

#[derive(Deserialize)]
struct RawMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct RawUsage {
    input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation: Option<RawCacheCreation>,
    speed: Option<String>,
    inference_geo: Option<String>,
}

#[derive(Deserialize)]
struct RawCacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

fn parse_line(line: &str) -> Option<UsageEntry> {
    // Cheap prefilter: most transcript lines are user/tool content without usage.
    if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    if raw.kind.as_deref() != Some("assistant") {
        return None;
    }
    let message = raw.message?;
    let usage = message.usage?;
    let model = message.model?;
    if model.starts_with('<') {
        return None;
    }
    let at = DateTime::parse_from_rfc3339(raw.timestamp.as_deref()?).ok()?;
    let key = match (message.id, raw.request_id) {
        (Some(id), Some(request)) => format!("{id}:{request}"),
        (Some(id), None) => id,
        (None, _) => raw.uuid?,
    };
    let cache_total = usage.cache_creation_input_tokens.unwrap_or(0);
    let (cache_write_5m, cache_write_1h) = match usage.cache_creation {
        Some(split) => {
            let one_hour = split.ephemeral_1h_input_tokens.unwrap_or(0);
            let five = split.ephemeral_5m_input_tokens.unwrap_or(0);
            // Keep the reported total authoritative if the split is partial.
            (five.max(cache_total.saturating_sub(one_hour)), one_hour)
        }
        None => (cache_total, 0),
    };
    Some(UsageEntry {
        key,
        at,
        model,
        input: usage.input_tokens.unwrap_or(0),
        cache_write_5m,
        cache_write_1h,
        cache_read: usage.cache_read_input_tokens.unwrap_or(0),
        output: usage.output_tokens.unwrap_or(0),
        fast: usage.speed.as_deref() == Some("fast"),
        us_geo: usage.inference_geo.as_deref() == Some("us"),
        session: raw.session_id,
        cwd: raw.cwd.filter(|value| !value.is_empty()),
    })
}

#[derive(Clone, Default)]
struct ParsedFile {
    entries: Vec<UsageEntry>,
    titles: Vec<(String, String)>,
}

fn read_file_entries(path: &Path) -> ParsedFile {
    let mut parsed = ParsedFile::default();
    let Ok(file) = fs::File::open(path) else {
        return parsed;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Some(entry) = parse_line(&line) {
            parsed.entries.push(entry);
        } else if let Some(title) = parse_title(&line) {
            parsed.titles.push(title);
        }
    }
    parsed
}

pub fn config_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        for part in value.to_string_lossy().split(',') {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }
    if roots.is_empty() {
        // Claude Code uses these two locations on macOS, Windows and Linux.
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join(".config").join("claude"));
            roots.push(home.join(".claude"));
        }
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for root in roots {
        let canonical = fs::canonicalize(&root).unwrap_or(root);
        if !unique.contains(&canonical) {
            unique.push(canonical);
        }
    }
    unique
}

fn collect_jsonl(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            collect_jsonl(&path, depth + 1, out);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

type FileCache = HashMap<PathBuf, (SystemTime, u64, ParsedFile)>;
static FILE_CACHE: Mutex<Option<FileCache>> = Mutex::new(None);

fn load_entries(roots: &[PathBuf]) -> (Vec<UsageEntry>, HashMap<String, String>, bool) {
    let mut files = Vec::new();
    let mut found_root = false;
    for root in roots {
        let projects = root.join("projects");
        if projects.is_dir() {
            found_root = true;
            collect_jsonl(&projects, 0, &mut files);
        }
    }
    let mut guard = FILE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    let mut next: FileCache = HashMap::with_capacity(files.len());
    let mut entries = Vec::new();
    let mut titles = HashMap::new();
    for path in files {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let parsed = match cache.remove(&path) {
            Some((cached_modified, cached_len, cached))
                if cached_modified == modified && cached_len == meta.len() =>
            {
                cached
            }
            _ => read_file_entries(&path),
        };
        entries.extend(parsed.entries.iter().cloned());
        titles.extend(parsed.titles.iter().cloned());
        next.insert(path, (modified, meta.len(), parsed));
    }
    *cache = next;
    (entries, titles, found_root)
}

/// Streaming can log one message several times; keep the most complete copy.
fn dedupe(entries: Vec<UsageEntry>) -> Vec<UsageEntry> {
    let mut by_key: HashMap<String, UsageEntry> = HashMap::with_capacity(entries.len());
    for entry in entries {
        match by_key.get(&entry.key) {
            Some(existing) if existing.output >= entry.output => {}
            _ => {
                by_key.insert(entry.key.clone(), entry);
            }
        }
    }
    by_key.into_values().collect()
}

fn model_name(model: &str) -> String {
    find_model(model)
        .map(|entry| entry.name.to_string())
        .unwrap_or_else(|| model.to_string())
}

fn canonical_model_id(model: &str) -> String {
    find_model(model)
        .map(|entry| entry.id.to_string())
        .unwrap_or_else(|| model.to_string())
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn add_usage(
    rows: &mut BTreeMap<String, ClaudeModelUsage>,
    id: String,
    name: impl FnOnce() -> String,
    detail: Option<String>,
    entry: &UsageEntry,
    cost: Option<f64>,
) {
    let row = rows.entry(id.clone()).or_insert_with(|| ClaudeModelUsage {
        id,
        name: name(),
        cost_usd: Some(0.0),
        detail,
        ..Default::default()
    });
    row.requests += 1;
    row.input_tokens += entry.input;
    row.cache_write_tokens += entry.cache_write();
    row.cache_read_tokens += entry.cache_read;
    row.output_tokens += entry.output;
    row.cost_usd = match (row.cost_usd, cost) {
        (Some(total), Some(value)) => Some(total + value),
        _ => None,
    };
}

fn sorted_rows(rows: BTreeMap<String, ClaudeModelUsage>) -> Vec<ClaudeModelUsage> {
    let mut rows: Vec<ClaudeModelUsage> = rows.into_values().collect();
    rows.sort_by(|a, b| {
        b.cost_usd
            .unwrap_or(f64::MAX)
            .total_cmp(&a.cost_usd.unwrap_or(f64::MAX))
    });
    rows
}

#[derive(Default)]
struct DayRows {
    day: ClaudeDailyUsage,
    models: BTreeMap<String, ClaudeModelUsage>,
    tasks: BTreeMap<String, ClaudeModelUsage>,
    projects: BTreeMap<String, ClaudeModelUsage>,
}

fn aggregate(
    entries: Vec<UsageEntry>,
    titles: &HashMap<String, String>,
    today: NaiveDate,
    days: u32,
) -> Vec<ClaudeDailyUsage> {
    let days = days.clamp(1, MAX_HISTORY_DAYS);
    let first = today - ChronoDuration::days(i64::from(days) - 1);
    let mut by_day: BTreeMap<NaiveDate, DayRows> = BTreeMap::new();
    for entry in dedupe(entries) {
        let date = usage_time::calendar_day(&entry.at);
        if date < first || date > today {
            continue;
        }
        let cost = entry.cost_usd();
        let rows = by_day.entry(date).or_insert_with(|| DayRows {
            day: ClaudeDailyUsage {
                local_date: date.to_string(),
                ..Default::default()
            },
            ..Default::default()
        });
        let day = &mut rows.day;
        day.requests += 1;
        day.input_tokens += entry.input;
        day.cache_write_tokens += entry.cache_write();
        day.cache_read_tokens += entry.cache_read;
        day.output_tokens += entry.output;
        match cost {
            Some(value) => day.cost_usd += value,
            None => day.unpriced_requests += 1,
        }
        add_usage(
            &mut rows.models,
            canonical_model_id(&entry.model),
            || model_name(&entry.model),
            None,
            &entry,
            cost,
        );
        let project = entry.cwd.as_deref().map(folder_name);
        if let Some(session) = entry.session.clone() {
            add_usage(
                &mut rows.tasks,
                session.clone(),
                || titles.get(&session).cloned().unwrap_or_default(),
                project.clone(),
                &entry,
                cost,
            );
        }
        if let (Some(path), Some(name)) = (entry.cwd.clone(), project) {
            add_usage(&mut rows.projects, path, || name, None, &entry, cost);
        }
    }
    by_day
        .into_values()
        .map(|rows| ClaudeDailyUsage {
            models: sorted_rows(rows.models),
            tasks: sorted_rows(rows.tasks),
            projects: sorted_rows(rows.projects),
            ..rows.day
        })
        .collect()
}

pub fn price_list() -> Vec<ClaudeModelPrice> {
    MODELS
        .iter()
        .map(|entry| ClaudeModelPrice {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            price: entry.standard,
        })
        .collect()
}

pub fn read_usage(days: u32) -> ClaudeUsageReport {
    let now = Utc::now();
    let roots = config_roots();
    let (entries, titles, found) = load_entries(&roots);
    let latest_activity_at = entries
        .iter()
        .map(|entry| entry.at)
        .max()
        .map(|at| at.with_timezone(&Utc).to_rfc3339());
    let today = usage_time::calendar_day(&now);
    ClaudeUsageReport {
        status: if found { "ok" } else { "unavailable" },
        observed_at: now.to_rfc3339(),
        latest_activity_at,
        price_checked_at: PRICE_TABLE_CHECKED_AT,
        days: aggregate(entries, &titles, today, days),
        prices: price_list(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, request: &str, at: &str, model: &str, usage: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{at}","requestId":"{request}","uuid":"u-{id}-{request}","message":{{"id":"{id}","model":"{model}","role":"assistant","content":[{{"type":"text","text":"secret body"}}],"usage":{usage}}}}}"#
        )
    }

    #[test]
    fn matches_snapshot_suffixes_without_prefix_collisions() {
        assert_eq!(
            find_model("claude-opus-4-5-20251101").unwrap().name,
            "Opus 4.5"
        );
        assert_eq!(find_model("claude-opus-4-20250514").unwrap().name, "Opus 4");
        assert_eq!(
            find_model("claude-opus-4-1-20250805").unwrap().name,
            "Opus 4.1"
        );
        assert_eq!(
            find_model("claude-sonnet-4-6[1m]").unwrap().name,
            "Sonnet 4.6"
        );
        assert_eq!(find_model("claude-opus-5-5").unwrap().name, "Opus 5.5");
        assert_eq!(find_model("claude-opus-5").unwrap().name, "Opus 5");
        assert!(find_model("claude-opus-5-9").is_none());
        assert!(find_model("gpt-5").is_none());
    }

    #[test]
    fn prices_cache_tiers_fast_mode_and_long_haiku_prompts() {
        let opus = parse_line(&line("m1", "r1", "2026-11-09T10:00:00Z", "claude-opus-5-5", r#"{"input_tokens":1000000,"cache_creation_input_tokens":2000000,"cache_read_input_tokens":1000000,"output_tokens":1000000,"cache_creation":{"ephemeral_5m_input_tokens":1000000,"ephemeral_1h_input_tokens":1000000}}"#)).unwrap();
        assert!((opus.cost_usd().unwrap() - (4.0 + 5.0 + 8.0 + 0.2 + 20.0)).abs() < 1e-9);
        let fast = parse_line(&line(
            "m2",
            "r2",
            "2026-11-09T10:00:00Z",
            "claude-opus-5-5",
            r#"{"input_tokens":1000000,"output_tokens":0,"speed":"fast"}"#,
        ))
        .unwrap();
        assert!((fast.cost_usd().unwrap() - 8.0).abs() < 1e-9);
        let short = parse_line(&line(
            "m3",
            "r3",
            "2026-11-09T10:00:00Z",
            "claude-haiku-5-5",
            r#"{"input_tokens":100000,"output_tokens":0}"#,
        ))
        .unwrap();
        assert!((short.cost_usd().unwrap() - 0.01).abs() < 1e-9);
        let long = parse_line(&line(
            "m4",
            "r4",
            "2026-11-09T10:00:00Z",
            "claude-haiku-5-5",
            r#"{"input_tokens":100001,"output_tokens":0}"#,
        ))
        .unwrap();
        assert!((long.cost_usd().unwrap() - 100_001.0 * 0.5 / 1e6).abs() < 1e-12);
        let us = parse_line(&line(
            "m5",
            "r5",
            "2026-11-09T10:00:00Z",
            "claude-sonnet-5-5",
            r#"{"input_tokens":1000000,"output_tokens":0,"inference_geo":"us"}"#,
        ))
        .unwrap();
        assert!((us.cost_usd().unwrap() - 2.2).abs() < 1e-9);
    }

    #[test]
    fn dedupes_streamed_copies_and_keeps_unknown_models_unpriced() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap();
        let entries = [
            line(
                "m1",
                "r1",
                "2026-11-09T17:00:00Z",
                "claude-sonnet-5-5",
                r#"{"input_tokens":10,"output_tokens":5}"#,
            ),
            line(
                "m1",
                "r1",
                "2026-11-09T17:00:01Z",
                "claude-sonnet-5-5",
                r#"{"input_tokens":10,"output_tokens":50}"#,
            ),
            line(
                "m2",
                "r2",
                "2026-11-09T17:00:02Z",
                "claude-future-9",
                r#"{"input_tokens":10,"output_tokens":5}"#,
            ),
            line(
                "m3",
                "r3",
                "2026-11-09T15:59:59Z",
                "claude-sonnet-5-5",
                r#"{"input_tokens":1,"output_tokens":1}"#,
            ),
            r#"{"type":"user","message":{"content":"no usage"}}"#.to_string(),
        ]
        .iter()
        .filter_map(|value| parse_line(value))
        .collect();
        let days = aggregate(entries, &HashMap::new(), today, 7);
        assert_eq!(days.len(), 2, "UTC+8 midnight splits 15:59Z and 17:00Z");
        let latest = days.last().unwrap();
        assert_eq!(latest.local_date, "2026-11-10");
        assert_eq!(latest.requests, 2);
        assert_eq!(latest.output_tokens, 55);
        assert_eq!(latest.unpriced_requests, 1);
        assert!(latest
            .models
            .iter()
            .any(|model| model.id == "claude-future-9" && model.cost_usd.is_none()));
        let sonnet = latest
            .models
            .iter()
            .find(|model| model.id == "claude-sonnet-5-5")
            .unwrap();
        assert!((sonnet.cost_usd.unwrap() - (10.0 * 2.0 + 50.0 * 10.0) / 1e6).abs() < 1e-12);
    }

    #[test]
    fn reads_nested_project_files_and_ignores_synthetic_messages() {
        let root =
            std::env::temp_dir().join(format!("cockpit-claude-usage-{}", std::process::id()));
        let nested = root
            .join("projects")
            .join("demo")
            .join("session")
            .join("subagents");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            nested.join("agent.jsonl"),
            [
                line(
                    "a",
                    "1",
                    "2026-11-09T10:00:00Z",
                    "claude-haiku-5-5",
                    r#"{"input_tokens":5,"output_tokens":5}"#,
                ),
                line(
                    "b",
                    "2",
                    "2026-11-09T10:00:00Z",
                    "<synthetic>",
                    r#"{"input_tokens":5,"output_tokens":5}"#,
                ),
            ]
            .join("\n"),
        )
        .unwrap();
        let (entries, _, found) = load_entries(std::slice::from_ref(&root));
        let _ = fs::remove_dir_all(&root);
        assert!(found);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model, "claude-haiku-5-5");
    }

    #[test]
    fn groups_usage_by_titled_session_and_working_folder() {
        let usage_line = |id: &str, session: &str, cwd: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"2026-11-10T02:00:00Z","requestId":"r-{id}","sessionId":"{session}","cwd":"{cwd}","message":{{"id":"{id}","model":"claude-opus-5-5","content":[{{"type":"text","text":"secret"}}],"usage":{{"input_tokens":1000000,"output_tokens":0}}}}}}"#
            )
        };
        let lines = [
            usage_line("a", "s1", "/work/alpha"),
            usage_line("b", "s1", "/work/alpha"),
            usage_line("c", "s2", "/work/beta"),
            r#"{"type":"custom-title","customTitle":"  Fix capsule  ","sessionId":"s1"}"#
                .to_string(),
        ];
        let entries: Vec<UsageEntry> = lines.iter().filter_map(|line| parse_line(line)).collect();
        let titles: HashMap<String, String> =
            lines.iter().filter_map(|line| parse_title(line)).collect();
        assert_eq!(titles.get("s1").map(String::as_str), Some("Fix capsule"));
        let day = aggregate(
            entries,
            &titles,
            NaiveDate::from_ymd_opt(2026, 11, 10).unwrap(),
            1,
        )
        .pop()
        .unwrap();
        assert_eq!(day.tasks.len(), 2);
        assert_eq!(day.tasks[0].id, "s1");
        assert_eq!(day.tasks[0].name, "Fix capsule");
        assert_eq!(day.tasks[0].detail.as_deref(), Some("alpha"));
        assert!((day.tasks[0].cost_usd.unwrap() - 8.0).abs() < 1e-9);
        assert_eq!(
            day.tasks[1].name, "",
            "untitled sessions are named by the UI"
        );
        assert_eq!(
            day.projects
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "beta"]
        );
    }
}

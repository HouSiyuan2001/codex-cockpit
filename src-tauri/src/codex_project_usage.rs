//! Local-only allowlisted metadata collector. No messages, credentials, or raw records
//! leave this module; no network, subprocesses, or persistent cache are used.
use crate::tokei_usage::{Metrics, ModelUsage, UsagePeriod};
use chrono::{DateTime, Local, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

const MAX_FILES: usize = 4000;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_LINE: usize = 2 * 1024 * 1024;
const MAX_SECONDS: u64 = 8;
const MAX_METADATA_ROWS: usize = 10_000;
const MAX_METADATA_BYTES: u64 = 128 * 1024 * 1024;
const MAX_METADATA_LINE: usize = 64 * 1024;
const MAX_METADATA_SECONDS: u64 = 2;

#[derive(Clone, Debug, Serialize)]
pub struct ProjectUsage {
    pub id: String,
    pub name: String,
    pub daily: BTreeMap<String, UsagePeriod>,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskRelation {
    Root,
    Subagent,
    Fork,
    Unlinked,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    pub relation: TaskRelation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    pub daily: BTreeMap<String, UsagePeriod>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsageSnapshot {
    pub device_id: Option<String>,
    pub updated_at: String,
    pub status: String,
    pub coverage: String,
    pub scanned_files: usize,
    pub pricing_source: String,
    pub pricing_updated_at: Option<String>,
    pub task_metadata_coverage: String,
    pub projects: Vec<ProjectUsage>,
    pub tasks: Vec<TaskUsage>,
    pub peer_tasks: Vec<Value>,
    pub warnings: Vec<String>,
}

// Serde ignores all unlisted fields, including response_item/message/tool payloads.
#[derive(Deserialize)]
struct Record {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    payload: Payload,
}
#[derive(Deserialize)]
struct Payload {
    id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    info: Option<Info>,
    forked_from_id: Option<String>,
    parent_thread_id: Option<String>,
}
#[derive(Deserialize)]
struct Info {
    total_token_usage: Option<Counts>,
    last_token_usage: Option<Counts>,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Hash)]
struct Counts {
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    reasoning_output_tokens: u64,
}
impl Counts {
    fn delta(self, old: Self) -> Option<Self> {
        Some(Self {
            input_tokens: self.input_tokens.checked_sub(old.input_tokens)?,
            cached_input_tokens: self
                .cached_input_tokens
                .checked_sub(old.cached_input_tokens)?,
            output_tokens: self.output_tokens.checked_sub(old.output_tokens)?,
            reasoning_output_tokens: self
                .reasoning_output_tokens
                .checked_sub(old.reasoning_output_tokens)?,
        })
    }
    fn valid(self) -> bool {
        self.cached_input_tokens <= self.input_tokens
            && self.reasoning_output_tokens <= self.output_tokens
            && self
                .input_tokens
                .checked_add(self.output_tokens)
                .is_some_and(|n| n <= 9_007_199_254_740_991)
    }
    fn metrics(self) -> Metrics {
        Metrics {
            input_tokens: self.input_tokens - self.cached_input_tokens,
            cached_input_tokens: self.cached_input_tokens,
            output_tokens: self.output_tokens,
            reasoning_tokens: self.reasoning_output_tokens,
            total_tokens: self.input_tokens + self.output_tokens,
            estimated_cost_usd: None,
        }
    }
}
fn safe_text(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
fn safe_path(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return false;
        }
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    true
}
fn short_file(path: &Path) -> Option<String> {
    if !safe_path(path) {
        return None;
    }
    // Never open FIFOs/devices or hydrate cloud-only project metadata.
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        if metadata.st_flags() & 0x40000000 != 0 {
            return None; // SF_DATALESS: opening would request cloud hydration.
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut s = String::new();
    file.take(4097).read_to_string(&mut s).ok()?;
    (s.len() <= 4096).then_some(s)
}
fn unassigned() -> (String, String) {
    ("unassigned".into(), "未归属".into())
}
fn project(cwd: Option<&str>, home: &Path, codex: &Path) -> (String, String) {
    // Project enrichment is optional. An external/cloud filesystem open can
    // block even with O_NONBLOCK, so never run it on the usage collector.
    static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    type ProjectCache = BTreeMap<String, (String, String)>;
    static RESOLVED: OnceLock<Mutex<ProjectCache>> = OnceLock::new();
    let Some(raw) = cwd.filter(|s| s.len() <= 4096) else {
        return unassigned();
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return unassigned();
    }
    if path == home || path == codex || path.starts_with(codex.join("workspaces")) {
        return unassigned();
    }
    let fallback = project_identity(&path);
    let cache = RESOLVED.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some(value) = cache.lock().ok().and_then(|c| c.get(raw).cloned()) {
        return value;
    }
    if BUSY
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Relaxed,
        )
        .is_err()
    {
        return fallback;
    }
    let raw = raw.to_owned();
    let home = home.to_owned();
    let codex = codex.to_owned();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("project-metadata".into())
        .spawn(move || {
            let value = resolve_project(Some(&raw), &home, &codex);
            if let Ok(mut cache) = cache.lock() {
                if cache.len() >= 4096 {
                    cache.clear();
                }
                cache.insert(raw, value.clone());
            }
            BUSY.store(false, std::sync::atomic::Ordering::Release);
            let _ = send.send(value);
        })
        .is_err()
    {
        BUSY.store(false, std::sync::atomic::Ordering::Release);
        return fallback;
    }
    receive
        .recv_timeout(Duration::from_millis(50))
        .unwrap_or(fallback)
}

fn resolve_project(cwd: Option<&str>, home: &Path, codex: &Path) -> (String, String) {
    let Some(raw) = cwd.filter(|s| s.len() <= 4096) else {
        return unassigned();
    };
    let path = PathBuf::from(raw);
    if !safe_path(&path) {
        return unassigned();
    }
    let path = fs::canonicalize(&path).unwrap_or(path);
    let home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let codex = fs::canonicalize(codex).unwrap_or_else(|_| codex.to_path_buf());
    if path == home || path == codex || path.starts_with(codex.join("workspaces")) {
        return unassigned();
    }
    let mut identity = path.clone();
    // Resolve worktree common-dir using Git metadata only; never invoke git/hooks.
    for ancestor in path.ancestors().take(64) {
        let dotgit = ancestor.join(".git");
        if dotgit.is_dir() && safe_path(&dotgit) {
            identity = ancestor.to_path_buf();
            break;
        }
        if let Some(s) = short_file(&dotgit) {
            if let Some(target) = s.trim().strip_prefix("gitdir: ") {
                let gitdir = ancestor.join(target);
                if let Ok(gitdir) = fs::canonicalize(gitdir) {
                    if let Some(common) = short_file(&gitdir.join("commondir")) {
                        if let Ok(common) = fs::canonicalize(gitdir.join(common.trim())) {
                            if common.file_name().is_some_and(|n| n == ".git") && safe_path(&common)
                            {
                                if let Some(root) = common.parent() {
                                    identity = root.to_path_buf();
                                }
                            }
                        }
                    }
                }
                break;
            }
        }
    }
    project_identity(&identity)
}

fn project_identity(identity: &Path) -> (String, String) {
    let name = identity
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| safe_text(s))
        .unwrap_or("项目")
        .to_owned();
    let key = identity.to_string_lossy();
    #[cfg(windows)]
    let key = key.to_lowercase();
    (
        format!("project-{:x}", Sha256::digest(key.as_bytes())),
        name,
    )
}
fn add(a: &mut Metrics, b: &Metrics) {
    a.estimated_cost_usd = if a.total_tokens == 0 {
        b.estimated_cost_usd
    } else {
        a.estimated_cost_usd
            .zip(b.estimated_cost_usd)
            .map(|(a, b)| a + b)
    };
    a.input_tokens = a.input_tokens.saturating_add(b.input_tokens);
    a.cached_input_tokens = a.cached_input_tokens.saturating_add(b.cached_input_tokens);
    a.output_tokens = a.output_tokens.saturating_add(b.output_tokens);
    a.reasoning_tokens = a.reasoning_tokens.saturating_add(b.reasoning_tokens);
    a.total_tokens = a.total_tokens.saturating_add(b.total_tokens);
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct Rate {
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    input: Option<f64>,
    #[serde(rename = "out", skip_serializing_if = "Option::is_none")]
    output: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    canonical_slug: Option<String>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PricingOrigin {
    App,
    Tokei,
    #[default]
    None,
}
impl PricingOrigin {
    fn label(self) -> &'static str {
        match self {
            Self::App => "app-catalog",
            // Preserve the public label used by the original local collector.
            Self::Tokei => "local-catalog",
            Self::None => "none",
        }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct Pricing {
    #[serde(default)]
    models: BTreeMap<String, Rate>,
    #[serde(default)]
    aliases: BTreeMap<String, String>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    meta: Option<PricingMeta>,
    #[serde(skip)]
    origin: PricingOrigin,
}
#[derive(Clone, Deserialize, Serialize)]
struct PricingMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}
impl Pricing {
    fn add_new_official_models(&mut self) {
        // Standard short-context text rates per 1M tokens. Existing catalog
        // entries and later local overrides take precedence over this fallback.
        for (id, input, cache_read, output) in [
            ("openai/gpt-6.1-sol", 2.0, 0.10, 10.0),
            ("openai/gpt-6-sol", 2.0, 0.20, 10.0),
            ("openai/gpt-6-luna", 0.10, 0.01, 0.50),
        ] {
            self.models.entry(id.into()).or_insert_with(|| Rate {
                input: Some(input),
                output: Some(output),
                cache_read: Some(cache_read),
                canonical_slug: None,
            });
        }
    }

    fn read_raw(path: &Path) -> Option<Pricing> {
        if !safe_path(path) {
            return None;
        }
        let f = fs::File::open(path).ok()?;
        if f.metadata().ok()?.len() > 2 * 1024 * 1024 {
            return None;
        }
        serde_json::from_reader(f.take(2 * 1024 * 1024 + 1)).ok()
    }

    fn valid_price(value: Option<f64>) -> bool {
        value.is_some_and(|value| value.is_finite() && value >= 0.0)
    }

    fn valid_model_id(id: &str) -> bool {
        safe_text(id) && id.len() <= 256
    }

    fn valid_rate(rate: &Rate) -> bool {
        Self::valid_price(rate.input)
            && Self::valid_price(rate.output)
            && Self::valid_price(rate.cache_read)
            && rate
                .canonical_slug
                .as_deref()
                .is_none_or(Self::valid_model_id)
    }

    fn sanitize_catalog(mut pricing: Pricing) -> Option<Pricing> {
        pricing
            .models
            .retain(|id, rate| Self::valid_model_id(id) && Self::valid_rate(rate));
        pricing
            .aliases
            .retain(|alias, target| Self::valid_model_id(alias) && Self::valid_model_id(target));
        if pricing
            .meta
            .as_ref()
            .and_then(|meta| meta.updated_at.as_deref())
            .is_some_and(|updated_at| !safe_text(updated_at))
        {
            pricing.meta = None;
        }
        if pricing.models.is_empty() {
            return None;
        }
        Some(pricing)
    }

    fn read_catalog(path: &Path) -> Option<Pricing> {
        Self::read_raw(path).and_then(Self::sanitize_catalog)
    }

    fn read_overrides(path: &Path) -> Option<Pricing> {
        let mut pricing = Self::read_raw(path)?;
        pricing.models.retain(|id, rate| {
            if !Self::valid_model_id(id) {
                return false;
            }
            if rate.input.is_some() && !Self::valid_price(rate.input) {
                rate.input = None;
            }
            if rate.output.is_some() && !Self::valid_price(rate.output) {
                rate.output = None;
            }
            if rate.cache_read.is_some() && !Self::valid_price(rate.cache_read) {
                rate.cache_read = None;
            }
            rate.input.is_some() || rate.output.is_some() || rate.cache_read.is_some()
        });
        pricing
            .aliases
            .retain(|alias, target| Self::valid_model_id(alias) && Self::valid_model_id(target));
        Some(pricing)
    }

    fn apply_overrides(&mut self, overrides: Pricing) {
        for (id, rate) in overrides.models {
            let old = self.models.entry(id).or_default();
            if rate.input.is_some() {
                old.input = rate.input;
            }
            if rate.output.is_some() {
                old.output = rate.output;
            }
            if rate.cache_read.is_some() {
                old.cache_read = rate.cache_read;
            }
        }
        self.aliases.extend(overrides.aliases);
    }

    fn load(home: &Path, app_catalog: Option<&Path>) -> Self {
        let (mut pricing, origin) = app_catalog
            .and_then(Self::read_catalog)
            .map(|pricing| (pricing, PricingOrigin::App))
            .or_else(|| {
                Self::read_catalog(&home.join(".tokei/pricing.json"))
                    .map(|pricing| (pricing, PricingOrigin::Tokei))
            })
            .unwrap_or_else(|| (Pricing::default(), PricingOrigin::None));
        pricing.add_new_official_models();
        if !app_catalog.is_some_and(|p| p.file_name().is_some_and(|n| n == "cloud-pricing.json")) {
            if let Some(overrides) =
                Self::read_overrides(&home.join(".tokei/pricing_overrides.json"))
            {
                pricing.apply_overrides(overrides);
            }
        }
        pricing.origin = origin;
        pricing
    }

    fn sanitized_legacy_pricing(home: &Path) -> Option<Value> {
        let pricing = Self::sanitize_catalog(Self::load(home, None))?;
        serde_json::to_value(pricing).ok()
    }
    fn estimate(&self, model: &str, delta: Counts, last: Option<Counts>) -> Option<f64> {
        let key = self.aliases.get(model).map(String::as_str).unwrap_or(model);
        let rate = self
            .models
            .get(key)
            .or_else(|| self.models.get(&format!("openai/{key}")))
            .or_else(|| {
                self.models
                    .values()
                    .find(|p| p.canonical_slug.as_deref() == Some(key))
            })?;
        let valid = |p: Option<f64>| p.filter(|v| v.is_finite() && *v >= 0.0);
        let (input, output, cached) = (
            valid(rate.input)?,
            valid(rate.output)?,
            valid(rate.cache_read)?,
        );
        // Only an exact per-event increment identifies the high-context tier.
        // Aggregated/missing context counts cannot safely be charged at base rate.
        let context = last.filter(|v| v.valid() && *v == delta)?;
        let high = context.input_tokens > 272_000;
        Some(
            ((delta.input_tokens - delta.cached_input_tokens) as f64
                * input
                * if high { 2.0 } else { 1.0 }
                + delta.cached_input_tokens as f64 * cached * if high { 2.0 } else { 1.0 }
                + delta.output_tokens as f64 * output * if high { 1.5 } else { 1.0 })
                / 1e6,
        )
    }
}

/// Return a small, validated catalog derived from the legacy Tokei files.
///
/// This intentionally round-trips through `Pricing` rather than exposing the
/// source JSON: unsupported fields and malformed rates never enter the app
/// catalog. The caller owns any atomic write to its app storage.
pub fn sanitized_legacy_pricing(home: &Path) -> Option<Value> {
    Pricing::sanitized_legacy_pricing(home)
}

pub fn shared_pricing_export(home: &Path, catalog: &Path) -> Option<Value> {
    let pricing = Pricing::sanitize_catalog(Pricing::load(home, Some(catalog)))?;
    let mut value = serde_json::to_value(pricing).ok()?;
    value.as_object_mut()?.remove("_meta");
    Some(value)
}

pub fn validate_shared_pricing(value: &Value) -> Result<Value, String> {
    let pricing: Pricing =
        serde_json::from_value(value.clone()).map_err(|_| "cloud_pricing_invalid")?;
    if pricing.models.is_empty()
        || pricing.models.len() > 2048
        || pricing.aliases.len() > 4096
        || pricing
            .models
            .iter()
            .any(|(id, rate)| !Pricing::valid_model_id(id) || !Pricing::valid_rate(rate))
        || pricing
            .aliases
            .iter()
            .any(|(a, b)| !Pricing::valid_model_id(a) || !Pricing::valid_model_id(b))
    {
        return Err("cloud_pricing_invalid".into());
    }
    serde_json::to_value(pricing).map_err(|_| "cloud_pricing_invalid".into())
}

#[derive(Clone, Debug, Default)]
struct ThreadDisplayMetadata {
    title: Option<String>,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
    source_parent_id: Option<String>,
    known_subagent: bool,
}

#[derive(Default)]
struct ThreadMetadataCatalog {
    entries: BTreeMap<String, ThreadDisplayMetadata>,
    warnings: HashSet<String>,
    database_loaded: bool,
    index_loaded: bool,
}

fn metadata_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| safe_text(value))
}

impl ThreadMetadataCatalog {
    fn load(codex: &Path) -> Self {
        let mut catalog = Self::default();
        catalog.load_database(&codex.join("state_5.sqlite"));
        catalog.load_session_index(&codex.join("session_index.jsonl"));
        if !catalog.database_loaded && !catalog.index_loaded {
            catalog.warnings.insert("task_metadata_unavailable".into());
        } else if !catalog.database_loaded {
            catalog
                .warnings
                .insert("task_metadata_database_unavailable".into());
        }
        catalog
    }

    fn load_database(&mut self, path: &Path) {
        #[derive(Deserialize)]
        struct SourceEnvelope {
            subagent: Option<SubagentSource>,
        }
        #[derive(Deserialize)]
        struct SubagentSource {
            thread_spawn: Option<ThreadSpawnSource>,
        }
        #[derive(Deserialize)]
        struct ThreadSpawnSource {
            parent_thread_id: Option<String>,
            agent_nickname: Option<String>,
            agent_role: Option<String>,
        }
        const ALLOWED: &[&str] = &[
            "id",
            "title",
            "source",
            "agent_nickname",
            "agent_role",
            "agent_path",
            "project_id",
            "thread_source",
            "name",
            "rollout_path",
        ];
        if !safe_path(path)
            || fs::metadata(path).is_err()
            || fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_METADATA_BYTES)
        {
            return;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let Ok(connection) = Connection::open_with_flags(path, flags) else {
            self.warnings
                .insert("task_metadata_database_unavailable".into());
            return;
        };
        let _ = connection.busy_timeout(Duration::from_millis(100));
        let Ok(mut schema) = connection.prepare("PRAGMA table_info(threads)") else {
            self.warnings.insert("task_metadata_database_schema".into());
            return;
        };
        let Ok(names) = schema.query_map([], |row| row.get::<_, String>(1)) else {
            self.warnings.insert("task_metadata_database_schema".into());
            return;
        };
        let available: HashSet<String> = names.filter_map(Result::ok).collect();
        let columns: Vec<&str> = ALLOWED
            .iter()
            .copied()
            .filter(|column| available.contains(*column))
            .collect();
        if !columns.contains(&"id") || (!columns.contains(&"title") && !columns.contains(&"name")) {
            self.warnings.insert("task_metadata_database_schema".into());
            return;
        }
        drop(schema);
        // Column names are selected only from the static allowlist above.
        let sql = format!("SELECT {} FROM threads LIMIT ?1", columns.join(", "));
        let Ok(mut statement) = connection.prepare(&sql) else {
            self.warnings.insert("task_metadata_database_schema".into());
            return;
        };
        let Ok(mut rows) = statement.query([MAX_METADATA_ROWS as i64 + 1]) else {
            self.warnings
                .insert("task_metadata_database_unavailable".into());
            return;
        };
        let started = Instant::now();
        let mut count = 0usize;
        loop {
            if count >= MAX_METADATA_ROWS
                || started.elapsed() >= Duration::from_secs(MAX_METADATA_SECONDS)
            {
                self.warnings.insert("task_metadata_database_limit".into());
                break;
            }
            let row = match rows.next() {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(_) => {
                    self.warnings
                        .insert("task_metadata_database_malformed".into());
                    break;
                }
            };
            count += 1;
            let value = |name: &str| {
                columns
                    .iter()
                    .position(|column| *column == name)
                    .and_then(|index| row.get::<_, Option<String>>(index).ok().flatten())
            };
            let Some(id) = metadata_text(value("id")) else {
                self.warnings
                    .insert("task_metadata_database_malformed".into());
                continue;
            };
            let title = metadata_text(value("title")).or_else(|| metadata_text(value("name")));
            let source = value("source")
                .filter(|value| value.len() <= 4096)
                .and_then(|value| serde_json::from_str::<SourceEnvelope>(&value).ok());
            let known_subagent = source
                .as_ref()
                .and_then(|source| source.subagent.as_ref())
                .is_some();
            let spawn = source
                .and_then(|source| source.subagent)
                .and_then(|subagent| subagent.thread_spawn);
            self.entries.insert(
                id,
                ThreadDisplayMetadata {
                    title,
                    agent_nickname: metadata_text(value("agent_nickname")).or_else(|| {
                        spawn
                            .as_ref()
                            .and_then(|spawn| metadata_text(spawn.agent_nickname.clone()))
                    }),
                    agent_role: metadata_text(value("agent_role")).or_else(|| {
                        spawn
                            .as_ref()
                            .and_then(|spawn| metadata_text(spawn.agent_role.clone()))
                    }),
                    source_parent_id: spawn
                        .as_ref()
                        .and_then(|spawn| metadata_text(spawn.parent_thread_id.clone())),
                    known_subagent,
                },
            );
        }
        self.database_loaded = true;
    }

    fn load_session_index(&mut self, path: &Path) {
        #[derive(Deserialize)]
        struct IndexRow {
            id: Option<String>,
            thread_name: Option<String>,
            updated_at: Option<String>,
        }
        if !safe_path(path) {
            return;
        }
        let Ok(file) = fs::File::open(path) else {
            return;
        };
        let Ok(file_metadata) = file.metadata() else {
            return;
        };
        if !file_metadata.is_file() || file_metadata.len() > MAX_METADATA_BYTES {
            self.warnings.insert("task_metadata_index_limit".into());
            return;
        }
        let started = Instant::now();
        let mut bytes = 0u64;
        let mut rows = 0usize;
        let mut newest: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            if rows >= MAX_METADATA_ROWS
                || bytes >= MAX_METADATA_BYTES
                || started.elapsed() >= Duration::from_secs(MAX_METADATA_SECONDS)
            {
                self.warnings.insert("task_metadata_index_limit".into());
                break;
            }
            line.clear();
            let size = match reader
                .by_ref()
                .take((MAX_METADATA_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(size) => size,
                Err(_) => {
                    self.warnings
                        .insert("task_metadata_index_unavailable".into());
                    return;
                }
            };
            bytes = bytes.saturating_add(size as u64);
            rows += 1;
            if size > MAX_METADATA_LINE || !line.ends_with(b"\n") {
                self.warnings.insert("task_metadata_index_malformed".into());
                continue;
            }
            let Ok(row) = serde_json::from_slice::<IndexRow>(&line) else {
                self.warnings.insert("task_metadata_index_malformed".into());
                continue;
            };
            let (Some(id), Some(title)) = (metadata_text(row.id), metadata_text(row.thread_name))
            else {
                self.warnings.insert("task_metadata_index_malformed".into());
                continue;
            };
            let updated_at = metadata_text(row.updated_at);
            if newest
                .get(&id)
                .is_none_or(|(_, old)| updated_at.as_ref() >= old.as_ref())
            {
                newest.insert(id, (title, updated_at));
            }
        }
        for (id, (title, _)) in newest {
            // The index carries the displayed/renamed task name; SQLite's title
            // can remain the initial user prompt. Keep database lineage metadata.
            self.entries.entry(id).or_default().title = Some(title);
        }
        self.index_loaded = true;
    }
}

#[derive(Default)]
struct Collector {
    pricing: Pricing,
    projects: BTreeMap<String, ProjectUsage>,
    tasks: BTreeMap<String, TaskAccumulator>,
    seen: HashSet<(String, String, Counts)>,
    links: BTreeMap<String, SessionLinks>,
    warnings: HashSet<String>,
    bytes: usize,
}
#[derive(Clone, Debug, Default)]
struct SessionLinks {
    replay_parent: Option<String>,
    owner_parent: Option<String>,
    known_subagent: bool,
}
#[derive(Clone, Debug, Default)]
struct TaskAccumulator {
    daily: BTreeMap<String, UsagePeriod>,
    project: Option<(String, String)>,
    mixed_project: bool,
}
struct FileState {
    offset: u64,
    previous: Counts,
    first_usage: bool,
    inherited_replay: bool,
    model: String,
    owner: (String, String),
    discarding: bool,
    lineage: String,
    task_id: String,
    modified: Option<SystemTime>,
    source_length: Option<u64>,
    identity: Option<(u64, u64)>,
}
impl Default for FileState {
    fn default() -> Self {
        Self {
            offset: 0,
            previous: Counts::default(),
            first_usage: true,
            inherited_replay: false,
            model: "unknown".into(),
            owner: unassigned(),
            discarding: false,
            lineage: "unknown-session".into(),
            task_id: "unlinked-session".into(),
            modified: None,
            source_length: None,
            identity: None,
        }
    }
}
#[derive(Default)]
struct Index {
    collector: Collector,
    files: BTreeMap<PathBuf, FileState>,
    metadata_loaded: HashSet<PathBuf>,
    session_ids: BTreeMap<PathBuf, String>,
    pricing_key: Option<PricingKey>,
}
impl Collector {
    fn register_meta(&mut self, payload: &Payload) {
        if let Some(id) = payload.id.as_ref().filter(|s| safe_text(s)) {
            let entry = self.links.entry(id.clone()).or_default();
            if let Some(parent) = payload.forked_from_id.as_ref().filter(|s| safe_text(s)) {
                entry.replay_parent = Some(parent.clone());
            }
            if let Some(parent) = payload.parent_thread_id.as_ref().filter(|s| safe_text(s)) {
                entry.owner_parent = Some(parent.clone());
                entry.known_subagent = true;
            }
        }
    }
    fn register_display_metadata(&mut self, metadata: &ThreadMetadataCatalog) {
        for (id, display) in &metadata.entries {
            let entry = self.links.entry(id.clone()).or_default();
            if entry.owner_parent.is_none() {
                entry.owner_parent = display.source_parent_id.clone();
            }
            entry.known_subagent |= display.known_subagent;
        }
    }
    fn replay_identity(&mut self, id: &str) -> String {
        let mut current = id;
        let mut chain = Vec::new();
        let mut positions = BTreeMap::new();
        for _ in 0..128 {
            if let Some(start) = positions.get(current).copied() {
                self.warnings.insert("task_metadata_replay_cycle".into());
                return chain[start..]
                    .iter()
                    .min()
                    .cloned()
                    .unwrap_or_else(|| id.to_owned());
            }
            positions.insert(current.to_owned(), chain.len());
            chain.push(current.to_owned());
            match self
                .links
                .get(current)
                .and_then(|links| links.replay_parent.as_deref())
            {
                Some(parent) => current = parent,
                None => break,
            }
        }
        if chain.len() == 128 {
            self.warnings
                .insert("task_metadata_replay_depth_limit".into());
        }
        current.to_owned()
    }
    fn replay_sort_info(&self, id: &str) -> (String, usize) {
        let mut current = id;
        let mut chain = Vec::new();
        let mut positions = BTreeMap::new();
        for _ in 0..128 {
            if let Some(start) = positions.get(current).copied() {
                let root = chain[start..]
                    .iter()
                    .min()
                    .cloned()
                    .unwrap_or_else(|| id.to_owned());
                return (root, chain.len());
            }
            positions.insert(current.to_owned(), chain.len());
            chain.push(current.to_owned());
            match self
                .links
                .get(current)
                .and_then(|links| links.replay_parent.as_deref())
            {
                Some(parent) => current = parent,
                None => return (current.to_owned(), chain.len().saturating_sub(1)),
            }
        }
        (current.to_owned(), 128)
    }
    fn task_relationship(&mut self, id: &str) -> (TaskRelation, Option<String>, Option<String>) {
        let Some(link) = self.links.get(id).cloned() else {
            return (TaskRelation::Unlinked, None, None);
        };
        if let Some(parent) = link.owner_parent.clone() {
            let mut current = parent.as_str();
            let mut seen = HashSet::from([id.to_owned()]);
            for _ in 0..128 {
                if !seen.insert(current.to_owned()) {
                    self.warnings.insert("task_metadata_parent_cycle".into());
                    return (TaskRelation::Unlinked, Some(parent), None);
                }
                let Some(current_link) = self.links.get(current) else {
                    self.warnings.insert("task_metadata_parent_missing".into());
                    return (TaskRelation::Unlinked, Some(parent), None);
                };
                match current_link.owner_parent.as_deref() {
                    Some(next) => current = next,
                    None => {
                        return (
                            TaskRelation::Subagent,
                            Some(parent.clone()),
                            Some(current.to_owned()),
                        );
                    }
                }
            }
            self.warnings
                .insert("task_metadata_parent_depth_limit".into());
            return (TaskRelation::Unlinked, Some(parent), None);
        }
        if link.known_subagent {
            self.warnings.insert("task_metadata_parent_missing".into());
            return (TaskRelation::Unlinked, None, None);
        }
        if let Some(parent) = link.replay_parent {
            return (TaskRelation::Fork, Some(parent), Some(id.to_owned()));
        }
        (TaskRelation::Root, None, Some(id.to_owned()))
    }
    fn rendered_tasks(&mut self, metadata: &ThreadMetadataCatalog) -> Vec<TaskUsage> {
        let rows: Vec<_> = self
            .tasks
            .iter()
            .map(|(id, task)| (id.clone(), task.clone()))
            .collect();
        rows.into_iter()
            .map(|(id, task)| {
                let display = metadata.entries.get(&id);
                if display.and_then(|row| row.title.as_ref()).is_none() {
                    self.warnings.insert("task_metadata_title_missing".into());
                }
                let (relation, parent_id, root_id) = self.task_relationship(&id);
                TaskUsage {
                    id,
                    name: display
                        .and_then(|row| row.title.clone())
                        .unwrap_or_else(|| "未命名任务".into()),
                    project_name: (!task.mixed_project)
                        .then(|| task.project.map(|(_, name)| name))
                        .flatten(),
                    parent_id,
                    root_id,
                    relation,
                    agent_nickname: display.and_then(|row| row.agent_nickname.clone()),
                    agent_role: display.and_then(|row| row.agent_role.clone()),
                    daily: task.daily,
                }
            })
            .collect()
    }
    #[cfg(test)]
    fn scan(&mut self, reader: impl BufRead, home: &Path, codex: &Path, started: Instant) {
        self.scan_from(reader, home, codex, started, &mut FileState::default());
    }
    fn scan_from(
        &mut self,
        reader: impl BufRead,
        home: &Path,
        codex: &Path,
        started: Instant,
        state: &mut FileState,
    ) {
        let mut reader = reader;
        let mut previous = state.previous;
        let mut first_usage = state.first_usage;
        let mut inherited_replay = state.inherited_replay;
        let mut model = state.model.clone();
        let mut owner = state.owner.clone();
        let mut task_id = state.task_id.clone();
        let mut line = Vec::new();
        loop {
            if self.bytes >= MAX_BYTES || started.elapsed() >= Duration::from_secs(MAX_SECONDS) {
                self.warnings.insert("scan_limit".into());
                break;
            }
            line.clear();
            // take() bounds memory even for a corrupt single gigantic JSONL line.
            let size = match reader
                .by_ref()
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => {
                    self.warnings.insert("file_unavailable".into());
                    break;
                }
            };
            self.bytes += size;
            if size > MAX_LINE || state.discarding {
                self.warnings.insert("line_limit".into());
                state.discarding = !line.ends_with(b"\n");
                state.offset += size as u64;
                continue;
            }
            if !line.ends_with(b"\n") {
                self.warnings.insert("incomplete_record".into());
                break;
            }
            state.offset += size as u64;
            let Ok(record) = serde_json::from_slice::<Record>(&line) else {
                self.warnings.insert("invalid_record".into());
                continue;
            };
            match record.kind.as_str() {
                "session_meta" => {
                    self.register_meta(&record.payload);
                    if let Some(id) = record.payload.id.as_deref().filter(|s| safe_text(s)) {
                        state.lineage = self.replay_identity(id);
                        task_id = id.to_owned();
                    }
                    owner = project(record.payload.cwd.as_deref(), home, codex);
                    inherited_replay = record.payload.forked_from_id.is_some();
                }
                "turn_context" => {
                    let c = record.payload;
                    if c.cwd.is_some() {
                        owner = project(c.cwd.as_deref(), home, codex);
                    }
                    model = c
                        .model
                        .filter(|s| safe_text(s))
                        .unwrap_or_else(|| "unknown".into());
                }
                "event_msg" if record.payload.kind.as_deref() == Some("token_count") => {
                    let Some(info) = record.payload.info else {
                        continue;
                    };
                    let Some(total) = info.total_token_usage.filter(|c| c.valid()) else {
                        self.warnings.insert("missing_totals".into());
                        continue;
                    };
                    let delta = if first_usage && inherited_replay {
                        // A fork may start after its inherited cumulative baseline.
                        // Only the explicit first incremental count is attributable.
                        self.warnings.insert("fork_initial_coverage".into());
                        info.last_token_usage
                            .filter(|last| last.valid() && total.delta(*last).is_some())
                    } else {
                        total.delta(previous)
                    };
                    first_usage = false;
                    previous = total;
                    let Some(delta) = delta.filter(|c| c.valid()) else {
                        self.warnings.insert("counter_reset".into());
                        continue;
                    };
                    if delta.input_tokens == 0 && delta.output_tokens == 0 {
                        continue;
                    }
                    let Some(time) = record
                        .timestamp
                        .and_then(|t| DateTime::parse_from_rfc3339(&t).ok())
                    else {
                        self.warnings.insert("invalid_timestamp".into());
                        continue;
                    };
                    if time > Utc::now() + chrono::Duration::minutes(5) {
                        self.warnings.insert("future_timestamp".into());
                        continue;
                    }
                    // Fork replay preserves original timestamp + cumulative snapshot.
                    // Global identity also deduplicates copies in archived_sessions.
                    if !self
                        .seen
                        .insert((state.lineage.clone(), time.to_utc().to_rfc3339(), total))
                    {
                        continue;
                    }
                    if model == "unknown" {
                        self.warnings.insert("unknown_model".into());
                    }
                    let day = time.with_timezone(&Local).date_naive().to_string();
                    let p = self
                        .projects
                        .entry(owner.0.clone())
                        .or_insert_with(|| ProjectUsage {
                            id: owner.0.clone(),
                            name: owner.1.clone(),
                            daily: BTreeMap::new(),
                        });
                    let d = p.daily.entry(day.clone()).or_insert_with(|| UsagePeriod {
                        start: Some(day.clone()),
                        end: None,
                        metrics: Counts::default().metrics(),
                        models: vec![],
                    });
                    let mut metrics = delta.metrics();
                    metrics.estimated_cost_usd =
                        self.pricing.estimate(&model, delta, info.last_token_usage);
                    add_daily(d, &model, &metrics);
                    let task = self.tasks.entry(task_id.clone()).or_default();
                    if owner.0 != "unassigned" {
                        match task.project.as_ref() {
                            None => task.project = Some(owner.clone()),
                            Some((id, _)) if id != &owner.0 => task.mixed_project = true,
                            _ => {}
                        }
                    }
                    let task_day = task
                        .daily
                        .entry(day.clone())
                        .or_insert_with(|| UsagePeriod {
                            start: Some(day),
                            end: None,
                            metrics: Counts::default().metrics(),
                            models: vec![],
                        });
                    add_daily(task_day, &model, &metrics);
                }
                _ => {}
            }
        }
        state.previous = previous;
        state.first_usage = first_usage;
        state.inherited_replay = inherited_replay;
        state.model = model;
        state.owner = owner;
        state.task_id = task_id;
    }
}

fn add_daily(day: &mut UsagePeriod, model: &str, metrics: &Metrics) {
    add(&mut day.metrics, metrics);
    if let Some(row) = day.models.iter_mut().find(|row| row.id == model) {
        add(&mut row.metrics, metrics);
    } else {
        day.models.push(ModelUsage {
            id: model.to_owned(),
            name: model.to_owned(),
            metrics: metrics.clone(),
        });
    }
}
fn files(
    root: &Path,
    found: &mut Vec<PathBuf>,
    depth: usize,
    warnings: &mut HashSet<String>,
    remaining: &mut usize,
) {
    if depth > 5 {
        warnings.insert("directory_depth_limit".into());
        return;
    }
    if !safe_path(root) {
        warnings.insert("unsafe_source".into());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        warnings.insert("directory_unavailable".into());
        return;
    };
    let mut candidates = Vec::new();
    for entry in entries {
        if *remaining == 0 {
            warnings.insert("directory_entry_limit".into());
            break;
        }
        *remaining -= 1;
        match entry {
            Ok(entry) => match entry.file_type() {
                Ok(kind) => candidates.push((
                    entry.path(),
                    kind,
                    entry.metadata().ok().and_then(|m| m.modified().ok()),
                )),
                Err(_) => {
                    warnings.insert("entry_unavailable".into());
                }
            },
            Err(_) => {
                warnings.insert("entry_unavailable".into());
            }
        }
    }
    // Codex date directories sort YYYY/MM/DD, then files use modification time;
    // order is deterministic before the overall file cap, not after truncation.
    candidates.sort_by(|a, b| {
        b.1.is_dir().cmp(&a.1.is_dir()).then_with(|| {
            if a.1.is_dir() && b.1.is_dir() {
                b.0.cmp(&a.0)
            } else {
                b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0))
            }
        })
    });
    for (path, kind, _) in candidates {
        if found.len() >= MAX_FILES {
            warnings.insert("file_limit".into());
            return;
        }
        if kind.is_symlink() {
            warnings.insert("unsafe_source".into());
            continue;
        }
        if kind.is_dir() {
            files(&path, found, depth + 1, warnings, remaining);
        } else if kind.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
            found.push(path);
        }
    }
}
fn file_identity(meta: &fs::Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        None
    }
}
fn source_changed(state: &FileState, meta: &fs::Metadata) -> bool {
    (state.identity.is_some() && state.identity != file_identity(meta))
        || (state.source_length == Some(meta.len())
            && state.modified.is_some()
            && state.modified != meta.modified().ok())
}

fn sort_paths_for_replay(
    paths: &mut [PathBuf],
    collector: &Collector,
    session_ids: &BTreeMap<PathBuf, String>,
) {
    let details: BTreeMap<PathBuf, (String, usize, Option<SystemTime>)> = paths
        .iter()
        .map(|path| {
            let (root, depth) = session_ids
                .get(path)
                .map(|id| collector.replay_sort_info(id))
                .unwrap_or_else(|| {
                    (
                        format!(
                            "source-{:x}",
                            Sha256::digest(path.to_string_lossy().as_bytes())
                        ),
                        0,
                    )
                });
            (
                path.clone(),
                (
                    root,
                    depth,
                    fs::metadata(path).and_then(|m| m.modified()).ok(),
                ),
            )
        })
        .collect();
    let mut group_recency: BTreeMap<String, Option<SystemTime>> = BTreeMap::new();
    for (root, _, modified) in details.values() {
        let current = group_recency.entry(root.clone()).or_default();
        if *modified > *current {
            *current = *modified;
        }
    }
    paths.sort_by(|a, b| {
        let (root_a, depth_a, modified_a) = &details[a];
        let (root_b, depth_b, modified_b) = &details[b];
        group_recency[root_b]
            .cmp(&group_recency[root_a])
            .then_with(|| root_a.cmp(root_b))
            .then_with(|| depth_a.cmp(depth_b))
            .then_with(|| modified_b.cmp(modified_a))
            .then_with(|| a.cmp(b))
    });
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PricingKey {
    path: Option<PathBuf>,
    length: Option<u64>,
    modified: Option<SystemTime>,
}
impl PricingKey {
    fn from_path(path: Option<&Path>) -> Self {
        let Some(path) = path else {
            return Self {
                path: None,
                length: None,
                modified: None,
            };
        };
        let metadata = fs::metadata(path).ok();
        Self {
            path: Some(path.to_path_buf()),
            length: metadata.as_ref().map(fs::Metadata::len),
            modified: metadata.and_then(|m| m.modified().ok()),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct MetadataFileKey {
    length: Option<u64>,
    modified: Option<SystemTime>,
}
impl MetadataFileKey {
    fn from_path(path: &Path) -> Self {
        let metadata = fs::metadata(path).ok();
        Self {
            length: metadata.as_ref().map(fs::Metadata::len),
            modified: metadata.and_then(|value| value.modified().ok()),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct TaskMetadataKey {
    database: MetadataFileKey,
    database_wal: MetadataFileKey,
    session_index: MetadataFileKey,
}
impl TaskMetadataKey {
    fn from_codex(codex: &Path) -> Self {
        Self {
            database: MetadataFileKey::from_path(&codex.join("state_5.sqlite")),
            database_wal: MetadataFileKey::from_path(&codex.join("state_5.sqlite-wal")),
            session_index: MetadataFileKey::from_path(&codex.join("session_index.jsonl")),
        }
    }
}
struct CachedProjectUsage {
    captured_at: Instant,
    pricing_key: PricingKey,
    task_metadata_key: TaskMetadataKey,
    snapshot: ProjectUsageSnapshot,
}
#[cfg(test)]
fn collect_increment(home: &Path, codex: &Path, index: &mut Index) -> ProjectUsageSnapshot {
    collect_increment_with_catalog(home, codex, index, None)
}
fn collect_increment_with_catalog(
    home: &Path,
    codex: &Path,
    index: &mut Index,
    app_catalog: Option<&Path>,
) -> ProjectUsageSnapshot {
    #[derive(Deserialize)]
    struct Config {
        device_id: Option<String>,
    }
    let device_id = short_file(&home.join(".tokei/config.json"))
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .and_then(|c| c.device_id)
        .filter(|s| safe_text(s) && !s.contains(['/', '\\']));
    let pricing_key = PricingKey::from_path(app_catalog);
    if index.pricing_key.as_ref() != Some(&pricing_key) {
        if !index.files.is_empty() || !index.collector.projects.is_empty() {
            *index = Index::default();
        }
        index.collector.pricing = Pricing::load(home, app_catalog);
        index.pricing_key = Some(pricing_key.clone());
    }
    // Truncation/replacement invalidates cumulative baselines; rebuild safely.
    if index
        .files
        .iter()
        .any(|(p, s)| fs::metadata(p).is_ok_and(|m| m.len() < s.offset))
    {
        *index = Index::default();
        index.collector.pricing = Pricing::load(home, app_catalog);
        index.pricing_key = Some(pricing_key);
        index.collector.warnings.insert("source_reindexed".into());
    }
    let c = &mut index.collector;
    c.bytes = 0;
    c.warnings.remove("scan_limit");
    c.warnings.remove("incomplete_record");
    c.warnings.remove("metadata_limit");
    c.warnings
        .retain(|warning| !warning.starts_with("task_metadata_"));
    let task_metadata = ThreadMetadataCatalog::load(codex);
    c.warnings.extend(task_metadata.warnings.iter().cloned());
    c.register_display_metadata(&task_metadata);
    for (path, state) in &index.files {
        match fs::metadata(path) {
            Ok(meta) if source_changed(state, &meta) => {
                c.warnings.insert("source_changed".into());
            }
            Err(_) => {
                c.warnings.insert("file_unavailable".into());
            }
            _ => {}
        }
    }
    if device_id.is_none() {
        c.warnings.insert("device_identity_unavailable".into());
    }
    let mut paths = Vec::new();
    let mut remaining_entries = 20_000;
    for name in ["sessions", "archived_sessions"] {
        files(
            &codex.join(name),
            &mut paths,
            0,
            &mut c.warnings,
            &mut remaining_entries,
        );
    }
    // Read only first-record metadata before usage so multi-level fork roots are
    // known independently of mtime ordering. Never parse or retain chat payloads.
    let metadata_started = Instant::now();
    let mut metadata_bytes = 0usize;
    for path in &paths {
        if metadata_bytes >= 32 * 1024 * 1024
            || metadata_started.elapsed() >= Duration::from_secs(2)
        {
            c.warnings.insert("metadata_limit".into());
            break;
        }
        if index.metadata_loaded.contains(path) || !safe_path(path) {
            continue;
        }
        if let Ok(file) = fs::File::open(path) {
            let mut line = Vec::new();
            if BufReader::new(file)
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut line)
                .is_ok()
                && line.len() <= MAX_LINE
            {
                if let Ok(record) = serde_json::from_slice::<Record>(&line) {
                    if record.kind == "session_meta" {
                        if let Some(id) = record.payload.id.as_ref().filter(|id| safe_text(id)) {
                            index.session_ids.insert(path.clone(), id.clone());
                        }
                        c.register_meta(&record.payload);
                    }
                }
            }
            metadata_bytes += line.len();
            index.metadata_loaded.insert(path.clone());
        }
    }
    // Keep recent replay groups first, but always process their provenance root
    // before inherited forks so identical history is attributed deterministically.
    sort_paths_for_replay(&mut paths, c, &index.session_ids);
    let started = Instant::now();
    for path in paths {
        if c.bytes >= MAX_BYTES || started.elapsed() >= Duration::from_secs(MAX_SECONDS) {
            c.warnings.insert("scan_limit".into());
            break;
        }
        if !safe_path(&path) {
            c.warnings.insert("unsafe_source".into());
            continue;
        }
        let state = index
            .files
            .entry(path.clone())
            .or_insert_with(|| FileState {
                lineage: format!(
                    "source-{:x}",
                    Sha256::digest(path.to_string_lossy().as_bytes())
                ),
                task_id: format!(
                    "unlinked-{:x}",
                    Sha256::digest(path.to_string_lossy().as_bytes())
                ),
                ..FileState::default()
            });
        if let Ok(meta) = fs::metadata(&path) {
            if source_changed(state, &meta) {
                c.warnings.insert("source_changed".into());
                continue;
            }
            if meta.len() == state.offset {
                continue;
            }
        }
        match fs::File::open(&path) {
            Ok(mut file) => {
                if file.seek(SeekFrom::Start(state.offset)).is_err() {
                    c.warnings.insert("file_unavailable".into());
                    continue;
                }
                c.scan_from(BufReader::new(file), home, codex, started, state);
                if let Ok(meta) = fs::metadata(&path) {
                    state.modified = meta.modified().ok();
                    state.source_length = Some(meta.len());
                    state.identity = file_identity(&meta);
                }
            }
            Err(_) => {
                c.warnings.insert("file_unavailable".into());
            }
        }
    }
    let tasks = c.rendered_tasks(&task_metadata);
    let matched_titles = tasks
        .iter()
        .filter(|task| {
            task_metadata
                .entries
                .get(&task.id)
                .and_then(|metadata| metadata.title.as_ref())
                .is_some()
        })
        .count();
    let task_metadata_coverage = if tasks.is_empty() {
        "complete"
    } else if matched_titles == 0 {
        "unavailable"
    } else if matched_titles == tasks.len()
        && !c
            .warnings
            .iter()
            .any(|warning| warning.starts_with("task_metadata_"))
    {
        "complete"
    } else {
        "partial"
    };
    // Title/relationship metadata is a separate local-only failure domain. Its
    // degradation must not make otherwise complete aggregate token data stale.
    let usage_warnings = c
        .warnings
        .iter()
        .any(|warning| !warning.starts_with("task_metadata_"));
    let status = if c.projects.is_empty() {
        "unavailable"
    } else if !usage_warnings {
        "ready"
    } else {
        "partial"
    };
    let mut warnings: Vec<_> = c.warnings.iter().cloned().collect();
    warnings.sort();
    ProjectUsageSnapshot {
        device_id,
        updated_at: Utc::now().to_rfc3339(),
        status: status.into(),
        coverage: "local".into(),
        scanned_files: index.files.len(),
        pricing_source: c.pricing.origin.label().into(),
        pricing_updated_at: c
            .pricing
            .meta
            .as_ref()
            .and_then(|m| m.updated_at.clone())
            .filter(|s| safe_text(s)),
        task_metadata_coverage: task_metadata_coverage.into(),
        projects: c.projects.values().cloned().collect(),
        tasks,
        peer_tasks: Vec::new(),
        warnings,
    }
}
#[allow(dead_code)]
pub async fn get_codex_project_usage() -> Result<ProjectUsageSnapshot, String> {
    get_codex_project_usage_with_catalog(None).await
}

pub async fn get_codex_project_usage_with_catalog(
    app_catalog: Option<PathBuf>,
) -> Result<ProjectUsageSnapshot, String> {
    static CACHE: OnceLock<Mutex<Option<CachedProjectUsage>>> = OnceLock::new();
    static INDEX: OnceLock<Mutex<Index>> = OnceLock::new();
    // A timed-out blocking filesystem operation must not create an unbounded
    // queue of workers waiting for the same collector lock.
    static FLIGHT: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = FLIGHT
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "collector_busy".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if app_catalog.as_deref().is_some_and(|path| !safe_path(path)) {
            return Err("unsafe_pricing_path".into());
        }
        let home = dirs::home_dir().ok_or_else(|| "home_unavailable".to_owned())?;
        let codex = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        if !safe_path(&codex) {
            return Err("unsafe_source".into());
        }
        let pricing_key = PricingKey::from_path(app_catalog.as_deref());
        let task_metadata_key = TaskMetadataKey::from_codex(&codex);
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "collector_unavailable".to_owned())?;
        if let Some(cached) = cache.as_ref() {
            if cached.pricing_key == pricing_key
                && cached.task_metadata_key == task_metadata_key
                && cached.captured_at.elapsed()
                    < Duration::from_secs(
                        if cached
                            .snapshot
                            .warnings
                            .iter()
                            .any(|warning| warning == "scan_limit")
                        {
                            1
                        } else {
                            60
                        },
                    )
            {
                return Ok(cached.snapshot.clone());
            }
        }
        let mut index = INDEX
            .get_or_init(|| Mutex::new(Index::default()))
            .lock()
            .map_err(|_| "collector_unavailable".to_owned())?;
        let result =
            collect_increment_with_catalog(&home, &codex, &mut index, app_catalog.as_deref());
        *cache = Some(CachedProjectUsage {
            captured_at: Instant::now(),
            pricing_key,
            task_metadata_key,
            snapshot: result.clone(),
        });
        Ok(result)
    })
    .await
    .map_err(|_| "collector_unavailable".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn short_metadata_rejects_fifo_before_opening() {
        use std::os::unix::ffi::OsStrExt;
        let dir = metadata_fixture_dir("metadata-fifo");
        let path = dir.join(".git");
        let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
        assert_eq!(short_file(&path), None);
        fs::remove_file(&path).unwrap();
        fs::write(&path, "gitdir: example").unwrap();
        assert_eq!(short_file(&path).as_deref(), Some("gitdir: example"));
        fs::write(&path, "x".repeat(4097)).unwrap();
        assert_eq!(short_file(&path), None);
        fs::remove_dir_all(dir).unwrap();
    }
    fn run(lines: &[&str]) -> Collector {
        run_with_pricing(lines, Pricing::default())
    }
    fn run_with_pricing(lines: &[&str], pricing: Pricing) -> Collector {
        let mut c = Collector {
            pricing,
            ..Collector::default()
        };
        c.scan(
            std::io::Cursor::new(format!("{}\n", lines.join("\n"))),
            Path::new("/home/test"),
            Path::new("/home/test/.codex"),
            Instant::now(),
        );
        c
    }
    const CONTEXT: &str = r#"{"type":"turn_context","payload":{"model":"model-test","cwd":"/synthetic/repo","message":"SECRET"}}"#;
    const FIRST: &str = r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":10,"reasoning_output_tokens":5},"last_token_usage":{"input_tokens":9999,"output_tokens":0}},"message":"SECRET"}}"#;
    const SECOND: &str = r#"{"timestamp":"2026-01-01T01:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"cached_input_tokens":100,"output_tokens":20,"reasoning_output_tokens":8}}}}"#;
    const THIRD: &str = r#"{"timestamp":"2026-01-01T02:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":180,"cached_input_tokens":110,"output_tokens":30,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":30,"cached_input_tokens":10,"output_tokens":10,"reasoning_output_tokens":2}}}}"#;
    fn metadata(rows: &[(&str, &str)]) -> ThreadMetadataCatalog {
        ThreadMetadataCatalog {
            entries: rows
                .iter()
                .map(|(id, title)| {
                    (
                        (*id).to_owned(),
                        ThreadDisplayMetadata {
                            title: Some((*title).to_owned()),
                            ..ThreadDisplayMetadata::default()
                        },
                    )
                })
                .collect(),
            database_loaded: true,
            ..ThreadMetadataCatalog::default()
        }
    }
    fn task_tokens(task: &TaskUsage) -> u64 {
        task.daily
            .values()
            .map(|day| day.metrics.total_tokens)
            .sum()
    }
    #[test]
    fn cumulative_deltas_repeated_last_and_privacy() {
        let c = run(&[CONTEXT, FIRST, FIRST, SECOND]);
        let p = c.projects.values().next().unwrap();
        let m = &p.daily.values().next().unwrap().metrics;
        assert_eq!(m.total_tokens, 170);
        assert_eq!(m.input_tokens, 50);
        assert_eq!(m.cached_input_tokens, 100);
        assert_eq!(m.reasoning_tokens, 8);
        assert!(m.estimated_cost_usd.is_none());
        assert!(!serde_json::to_string(p).unwrap().contains("SECRET"));
    }
    #[test]
    fn source_model_ids_remain_distinct_across_turns() {
        let sol =
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol","cwd":"/synthetic/repo"}}"#;
        let luna =
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-luna","cwd":"/synthetic/repo"}}"#;
        let astra =
            r#"{"type":"turn_context","payload":{"model":"gpt-6-astra","cwd":"/synthetic/repo"}}"#;
        let new_sol =
            r#"{"type":"turn_context","payload":{"model":"gpt-6-sol","cwd":"/synthetic/repo"}}"#;
        let new_luna =
            r#"{"type":"turn_context","payload":{"model":"gpt-6-luna","cwd":"/synthetic/repo"}}"#;
        let first = r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":30,"output_tokens":0},"last_token_usage":{"input_tokens":30,"output_tokens":0}}}}"#;
        let second = r#"{"timestamp":"2026-01-01T01:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":60,"output_tokens":0},"last_token_usage":{"input_tokens":30,"output_tokens":0}}}}"#;
        let third = r#"{"timestamp":"2026-01-01T02:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":0},"last_token_usage":{"input_tokens":40,"output_tokens":0}}}}"#;
        let fourth = r#"{"timestamp":"2026-01-01T03:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":130,"output_tokens":0},"last_token_usage":{"input_tokens":30,"output_tokens":0}}}}"#;
        let fifth = r#"{"timestamp":"2026-01-01T04:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":160,"output_tokens":0},"last_token_usage":{"input_tokens":30,"output_tokens":0}}}}"#;
        let collector = run(&[
            sol, first, luna, second, astra, third, new_sol, fourth, new_luna, fifth,
        ]);
        let day = collector
            .projects
            .values()
            .next()
            .unwrap()
            .daily
            .values()
            .next()
            .unwrap();
        let models: BTreeMap<_, _> = day
            .models
            .iter()
            .map(|model| (model.id.as_str(), model.metrics.total_tokens))
            .collect();
        assert_eq!(
            models,
            BTreeMap::from([
                ("gpt-5.6-luna", 30),
                ("gpt-5.6-sol", 30),
                ("gpt-6-astra", 40),
                ("gpt-6-sol", 30),
                ("gpt-6-luna", 30),
            ])
        );
    }
    #[test]
    fn exact_model_identity_and_cost_survive_collector_snapshot_roundtrip() {
        let rate = |input| Rate {
            input: Some(input),
            output: Some(0.0),
            cache_read: Some(0.0),
            canonical_slug: None,
        };
        let pricing = Pricing {
            models: BTreeMap::from([
                ("gpt-5.6-sol".into(), rate(10.0)),
                ("gpt-5.6-luna".into(), rate(20.0)),
                ("gpt-6-astra".into(), rate(30.0)),
            ]),
            ..Pricing::default()
        };
        let sol = r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol","cwd":"/synthetic/repo","message":"DO_NOT_COPY"}}"#;
        let luna = r#"{"type":"turn_context","payload":{"model":"gpt-5.6-luna","cwd":"/synthetic/repo","message":"DO_NOT_COPY"}}"#;
        let astra = r#"{"type":"turn_context","payload":{"model":"gpt-6-astra","cwd":"/synthetic/repo","message":"DO_NOT_COPY"}}"#;
        let first = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100000,"output_tokens":0},"last_token_usage":{"input_tokens":100000,"output_tokens":0}}},"message":"DO_NOT_COPY"}"#;
        let second = r#"{"timestamp":"2026-09-22T00:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300000,"output_tokens":0},"last_token_usage":{"input_tokens":200000,"output_tokens":0}}},"message":"DO_NOT_COPY"}"#;
        let third = r#"{"timestamp":"2026-09-22T00:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":550000,"output_tokens":0},"last_token_usage":{"input_tokens":250000,"output_tokens":0}}},"message":"DO_NOT_COPY"}"#;
        let collector = run_with_pricing(&[sol, first, luna, second, astra, third], pricing);
        let collected = ProjectUsageSnapshot {
            device_id: Some("device".into()),
            updated_at: "2026-09-22T00:03:00Z".into(),
            status: "ready".into(),
            coverage: "local".into(),
            scanned_files: 1,
            pricing_source: "test-catalog".into(),
            pricing_updated_at: None,
            task_metadata_coverage: "complete".into(),
            projects: collector.projects.values().cloned().collect(),
            tasks: Vec::new(),
            peer_tasks: Vec::new(),
            warnings: Vec::new(),
        };
        let wire = crate::usage_sync_snapshot::build_at(
            "device",
            &collected,
            &[],
            chrono::NaiveDate::from_ymd_opt(2026, 9, 22).unwrap(),
        )
        .unwrap();
        assert!(!wire.to_string().contains("DO_NOT_COPY"));
        let parsed = crate::tokei_usage::parse_device(&wire, "device", None).unwrap();
        let day = &parsed.daily["2026-09-22"];
        let models: BTreeMap<_, _> = day
            .models
            .iter()
            .map(|model| {
                (
                    model.id.as_str(),
                    (
                        model.metrics.total_tokens,
                        model.metrics.estimated_cost_usd.unwrap(),
                    ),
                )
            })
            .collect();
        assert_eq!(models["gpt-5.6-sol"].0, 100_000);
        assert!((models["gpt-5.6-sol"].1 - 1.0).abs() < 1e-10);
        assert_eq!(models["gpt-5.6-luna"].0, 200_000);
        assert!((models["gpt-5.6-luna"].1 - 4.0).abs() < 1e-10);
        assert_eq!(models["gpt-6-astra"].0, 250_000);
        assert!((models["gpt-6-astra"].1 - 7.5).abs() < 1e-10);
        assert_eq!(day.metrics.total_tokens, 550_000);
        assert!((day.metrics.estimated_cost_usd.unwrap() - 12.5).abs() < 1e-10);
    }
    #[test]
    fn fork_replay_is_not_counted_twice() {
        let mut c = run(&[CONTEXT, FIRST, SECOND]);
        c.scan(
            std::io::Cursor::new(format!("{CONTEXT}\n{FIRST}\n{SECOND}\n")),
            Path::new("/home/test"),
            Path::new("/home/test/.codex"),
            Instant::now(),
        );
        assert_eq!(
            c.projects
                .values()
                .next()
                .unwrap()
                .daily
                .values()
                .next()
                .unwrap()
                .metrics
                .total_tokens,
            170
        );
    }
    #[test]
    fn independent_sessions_do_not_collide_but_fork_lineage_deduplicates() {
        let parent = r#"{"type":"session_meta","payload":{"id":"parent","cwd":"/synthetic/repo"}}"#;
        let other =
            r#"{"type":"session_meta","payload":{"id":"independent","cwd":"/synthetic/repo"}}"#;
        let fork = r#"{"type":"session_meta","payload":{"id":"child","forked_from_id":"parent","cwd":"/synthetic/repo"}}"#;
        let mut c = run(&[parent, CONTEXT, FIRST, SECOND]);
        let h = Path::new("/home/test");
        let codex = h.join(".codex");
        c.scan(
            std::io::Cursor::new(format!("{other}\n{CONTEXT}\n{FIRST}\n{SECOND}\n")),
            h,
            &codex,
            Instant::now(),
        );
        assert_eq!(
            c.projects
                .values()
                .next()
                .unwrap()
                .daily
                .values()
                .next()
                .unwrap()
                .metrics
                .total_tokens,
            340
        );
        c.scan(
            std::io::Cursor::new(format!("{fork}\n{CONTEXT}\n{FIRST}\n{SECOND}\n")),
            h,
            &codex,
            Instant::now(),
        );
        assert_eq!(
            c.projects
                .values()
                .next()
                .unwrap()
                .daily
                .values()
                .next()
                .unwrap()
                .metrics
                .total_tokens,
            340
        );
    }
    #[test]
    fn spawned_child_has_own_usage_and_folds_to_root() {
        let parent = r#"{"type":"session_meta","payload":{"id":"parent","cwd":"/synthetic/repo"}}"#;
        let child = r#"{"type":"session_meta","payload":{"id":"child","parent_thread_id":"parent","cwd":"/synthetic/repo"}}"#;
        let mut c = run(&[parent, CONTEXT, FIRST, SECOND]);
        let h = Path::new("/home/test");
        c.scan(
            std::io::Cursor::new(format!("{child}\n{CONTEXT}\n{FIRST}\n{SECOND}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let tasks = c.rendered_tasks(&metadata(&[("parent", "Parent"), ("child", "Child")]));
        let parent = tasks.iter().find(|task| task.id == "parent").unwrap();
        let child = tasks.iter().find(|task| task.id == "child").unwrap();
        assert_eq!(task_tokens(parent), 170);
        assert_eq!(task_tokens(child), 170);
        assert_eq!(child.relation, TaskRelation::Subagent);
        assert_eq!(child.parent_id.as_deref(), Some("parent"));
        assert_eq!(child.root_id.as_deref(), Some("parent"));
        assert_eq!(
            c.projects
                .values()
                .flat_map(|project| project.daily.values())
                .map(|day| day.metrics.total_tokens)
                .sum::<u64>(),
            340
        );
    }
    #[test]
    fn ordinary_fork_deduplicates_replay_but_keeps_standalone_work() {
        let parent = r#"{"type":"session_meta","payload":{"id":"parent","cwd":"/synthetic/repo"}}"#;
        let fork = r#"{"type":"session_meta","payload":{"id":"fork","forked_from_id":"parent","cwd":"/synthetic/repo"}}"#;
        let mut c = run(&[parent, CONTEXT, FIRST, SECOND]);
        let h = Path::new("/home/test");
        c.scan(
            std::io::Cursor::new(format!("{fork}\n{CONTEXT}\n{FIRST}\n{SECOND}\n{THIRD}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let tasks = c.rendered_tasks(&metadata(&[("parent", "Parent"), ("fork", "Fork")]));
        let fork = tasks.iter().find(|task| task.id == "fork").unwrap();
        assert_eq!(task_tokens(fork), 40);
        assert_eq!(fork.relation, TaskRelation::Fork);
        assert_eq!(fork.parent_id.as_deref(), Some("parent"));
        assert_eq!(fork.root_id.as_deref(), Some("fork"));
        assert_eq!(
            c.projects
                .values()
                .flat_map(|project| project.daily.values())
                .map(|day| day.metrics.total_tokens)
                .sum::<u64>(),
            210
        );
    }
    fn collect_replay_fixture(parent_name: &str, fork_name: &str) -> BTreeMap<String, u64> {
        let home = metadata_fixture_dir("replay-order");
        let codex = home.join(".codex");
        fs::create_dir_all(codex.join("sessions")).unwrap();
        fs::create_dir_all(codex.join("archived_sessions")).unwrap();
        let parent = r#"{"type":"session_meta","payload":{"id":"parent","cwd":"/synthetic/repo"}}"#;
        let fork = r#"{"type":"session_meta","payload":{"id":"fork","forked_from_id":"parent","cwd":"/synthetic/repo"}}"#;
        fs::write(
            codex.join("sessions").join(parent_name),
            format!("{parent}\n{CONTEXT}\n{FIRST}\n{SECOND}\n"),
        )
        .unwrap();
        fs::write(
            codex.join("sessions").join(fork_name),
            format!("{fork}\n{CONTEXT}\n{FIRST}\n{SECOND}\n{THIRD}\n"),
        )
        .unwrap();
        let snapshot = collect_increment(&home, &codex, &mut Index::default());
        let result = snapshot
            .tasks
            .iter()
            .map(|task| (task.id.clone(), task_tokens(task)))
            .collect();
        fs::remove_dir_all(home).unwrap();
        result
    }
    #[test]
    fn reversed_parent_and_fork_file_order_has_stable_self_attribution() {
        let parent_first = collect_replay_fixture("a-parent.jsonl", "z-fork.jsonl");
        let fork_first = collect_replay_fixture("z-parent.jsonl", "a-fork.jsonl");
        assert_eq!(parent_first, fork_first);
        assert_eq!(parent_first.get("parent"), Some(&170));
        assert_eq!(parent_first.get("fork"), Some(&40));
    }
    #[test]
    fn copied_replay_counts_once_for_the_same_stable_task_id() {
        let meta = r#"{"type":"session_meta","payload":{"id":"copied","cwd":"/synthetic/repo"}}"#;
        let mut c = run(&[meta, CONTEXT, FIRST, SECOND]);
        let h = Path::new("/home/test");
        c.scan(
            std::io::Cursor::new(format!("{meta}\n{CONTEXT}\n{FIRST}\n{SECOND}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let tasks = c.rendered_tasks(&metadata(&[("copied", "Copied")]));
        assert_eq!(tasks.len(), 1);
        assert_eq!(task_tokens(&tasks[0]), 170);
    }
    #[test]
    fn missing_parent_and_cycles_are_unlinked_without_losing_usage() {
        let missing = r#"{"type":"session_meta","payload":{"id":"missing-child","parent_thread_id":"absent","cwd":"/synthetic/repo"}}"#;
        let cycle_a = r#"{"type":"session_meta","payload":{"id":"cycle-a","parent_thread_id":"cycle-b","cwd":"/synthetic/repo"}}"#;
        let cycle_b = r#"{"type":"session_meta","payload":{"id":"cycle-b","parent_thread_id":"cycle-a","cwd":"/synthetic/repo"}}"#;
        let mut c = run(&[missing, CONTEXT, FIRST]);
        let h = Path::new("/home/test");
        c.scan(
            std::io::Cursor::new(format!("{cycle_a}\n{CONTEXT}\n{FIRST}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        c.scan(
            std::io::Cursor::new(format!("{cycle_b}\n{CONTEXT}\n{FIRST}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let tasks = c.rendered_tasks(&metadata(&[
            ("missing-child", "Missing"),
            ("cycle-a", "A"),
            ("cycle-b", "B"),
        ]));
        assert_eq!(tasks.len(), 3);
        assert!(tasks
            .iter()
            .all(|task| task.relation == TaskRelation::Unlinked && task_tokens(task) == 110));
        assert!(c.warnings.contains("task_metadata_parent_missing"));
        assert!(c.warnings.contains("task_metadata_parent_cycle"));
    }
    #[test]
    fn malformed_missing_and_unknown_stay_explicit() {
        let c = run(&[
            "bad json",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
            FIRST,
        ]);
        assert!(c.warnings.contains("invalid_record"));
        assert!(c.warnings.contains("missing_totals"));
        assert!(c.warnings.contains("unknown_model"));
        assert!(c.projects.contains_key("unassigned"));
    }
    fn metadata_fixture_dir(label: &str) -> PathBuf {
        let raw = std::env::temp_dir().join(format!(
            "quota-task-metadata-{label}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&raw).unwrap();
        fs::canonicalize(raw).unwrap()
    }
    fn create_metadata_database(codex: &Path) -> Connection {
        let connection = Connection::open(codex.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    source TEXT,
                    agent_nickname TEXT,
                    agent_role TEXT,
                    agent_path TEXT,
                    project_id TEXT,
                    thread_source TEXT,
                    name TEXT,
                    rollout_path TEXT
                );",
            )
            .unwrap();
        connection
    }
    #[test]
    fn title_rename_changes_name_without_changing_task_id() {
        let codex = metadata_fixture_dir("rename");
        let connection = create_metadata_database(&codex);
        connection
            .execute(
                "INSERT INTO threads (id, title) VALUES (?1, ?2)",
                ["stable-id", "First title"],
            )
            .unwrap();
        let session =
            r#"{"type":"session_meta","payload":{"id":"stable-id","cwd":"/synthetic/repo"}}"#;
        let mut collector = run(&[session, CONTEXT, FIRST]);
        let first = collector.rendered_tasks(&ThreadMetadataCatalog::load(&codex));
        connection
            .execute(
                "UPDATE threads SET title = ?1 WHERE id = ?2",
                ["Renamed title", "stable-id"],
            )
            .unwrap();
        let renamed = collector.rendered_tasks(&ThreadMetadataCatalog::load(&codex));
        assert_eq!(first[0].id, renamed[0].id);
        assert_eq!(first[0].name, "First title");
        assert_eq!(renamed[0].name, "Renamed title");
        drop(connection);
        fs::remove_dir_all(codex).unwrap();
    }
    #[test]
    fn latest_index_name_overrides_initial_prompt_without_changing_usage() {
        let codex = metadata_fixture_dir("index-rename");
        let connection = create_metadata_database(&codex);
        connection
            .execute(
                "INSERT INTO threads (id, title) VALUES (?1, ?2)",
                ["stable-id", "Initial user question"],
            )
            .unwrap();
        let session =
            r#"{"type":"session_meta","payload":{"id":"stable-id","cwd":"/synthetic/repo"}}"#;
        let mut collector = run(&[session, CONTEXT, FIRST]);
        let before =
            serde_json::to_value(collector.rendered_tasks(&ThreadMetadataCatalog::load(&codex)))
                .unwrap();
        fs::write(codex.join("session_index.jsonl"), concat!(
            "{\"id\":\"stable-id\",\"thread_name\":\"Latest task name\",\"updated_at\":\"2026-09-10T00:00:00Z\"}\n",
            "{\"id\":\"stable-id\",\"thread_name\":\"Older name\",\"updated_at\":\"2026-09-01T00:00:00Z\"}\n"
        )).unwrap();
        let after =
            serde_json::to_value(collector.rendered_tasks(&ThreadMetadataCatalog::load(&codex)))
                .unwrap();
        let mut expected = before;
        expected[0]["name"] = serde_json::json!("Latest task name");
        assert_eq!(after, expected);
        drop(connection);
        fs::remove_dir_all(codex).unwrap();
    }
    #[test]
    fn modern_sqlite_subagent_source_supplies_owner_parent() {
        let codex = metadata_fixture_dir("modern-source");
        let connection = create_metadata_database(&codex);
        connection
            .execute(
                "INSERT INTO threads (id, title, source) VALUES (?1, ?2, ?3)",
                rusqlite::params!["root", "Root task", "root"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, title, source) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    "child",
                    "Child task",
                    r#"{"subagent":{"thread_spawn":{"parent_thread_id":"root","agent_nickname":"Helper","agent_role":"worker","agent_path":"/root/helper","depth":1}}}"#
                ],
            )
            .unwrap();
        drop(connection);
        let root = r#"{"type":"session_meta","payload":{"id":"root","cwd":"/synthetic/repo"}}"#;
        let child = r#"{"type":"session_meta","payload":{"id":"child","cwd":"/synthetic/repo"}}"#;
        let mut collector = run(&[root, CONTEXT, FIRST]);
        let h = Path::new("/home/test");
        collector.scan(
            std::io::Cursor::new(format!("{child}\n{CONTEXT}\n{FIRST}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let catalog = ThreadMetadataCatalog::load(&codex);
        collector.register_display_metadata(&catalog);
        let tasks = collector.rendered_tasks(&catalog);
        let child = tasks.iter().find(|task| task.id == "child").unwrap();
        assert_eq!(child.relation, TaskRelation::Subagent);
        assert_eq!(child.parent_id.as_deref(), Some("root"));
        assert_eq!(child.root_id.as_deref(), Some("root"));
        assert_eq!(child.agent_nickname.as_deref(), Some("Helper"));
        assert_eq!(child.agent_role.as_deref(), Some("worker"));
        assert_eq!(task_tokens(child), 110);
        fs::remove_dir_all(codex).unwrap();
    }
    #[test]
    fn malformed_metadata_is_bounded_and_private_with_index_fallback() {
        let codex = metadata_fixture_dir("privacy");
        let connection = create_metadata_database(&codex);
        connection
            .execute(
                "INSERT INTO threads
                 (id, title, source, agent_nickname, agent_role, agent_path,
                  project_id, thread_source, name, rollout_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    "database-task",
                    "Visible database title",
                    "SECRET_SOURCE",
                    "Helper",
                    "worker",
                    "SECRET_AGENT_PATH",
                    "SECRET_PROJECT_ID",
                    "SECRET_THREAD_SOURCE",
                    "SECRET_NAME",
                    "SECRET_ROLLOUT_PATH"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, title) VALUES (?1, ?2)",
                rusqlite::params!["bad-title", "bad\ntitle"],
            )
            .unwrap();
        fs::write(
            codex.join("session_index.jsonl"),
            concat!(
                "{\"id\":\"fallback-task\",\"thread_name\":\"Fallback title\",\"updated_at\":\"2026-01-01T00:00:00Z\",\"message\":\"SECRET_MESSAGE\",\"credentials\":\"SECRET_CREDENTIAL\"}\n",
                "not-json\n"
            ),
        )
        .unwrap();
        drop(connection);
        let catalog = ThreadMetadataCatalog::load(&codex);
        assert!(catalog.warnings.contains("task_metadata_index_malformed"));
        let database =
            r#"{"type":"session_meta","payload":{"id":"database-task","cwd":"/synthetic/repo"}}"#;
        let fallback =
            r#"{"type":"session_meta","payload":{"id":"fallback-task","cwd":"/synthetic/repo"}}"#;
        let mut collector = run(&[database, CONTEXT, FIRST]);
        let h = Path::new("/home/test");
        collector.scan(
            std::io::Cursor::new(format!("{fallback}\n{CONTEXT}\n{FIRST}\n")),
            h,
            &h.join(".codex"),
            Instant::now(),
        );
        let tasks = collector.rendered_tasks(&catalog);
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == "fallback-task")
                .unwrap()
                .name,
            "Fallback title"
        );
        let serialized = serde_json::to_string(&tasks).unwrap();
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("agent_path"));
        assert!(!serialized.contains("rollout_path"));
        fs::remove_dir_all(codex).unwrap();
    }
    #[test]
    fn path_identity_and_projectless() {
        #[cfg(not(unix))]
        let root = std::env::temp_dir().join("cockpit-path-test");
        #[cfg(unix)]
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("cockpit-path-test");
        let h = root.join("home");
        let c = h.join(".codex");
        assert_ne!(
            project(root.join("one/repo").to_str(), &h, &c).0,
            project(root.join("two/repo").to_str(), &h, &c).0
        );
        assert_eq!(project(h.to_str(), &h, &c).0, "unassigned");
        assert_eq!(
            project(c.join("workspaces/task").to_str(), &h, &c).0,
            "unassigned"
        );
    }
    #[test]
    fn subset_and_reset_are_rejected() {
        assert!(!Counts {
            input_tokens: 2,
            cached_input_tokens: 3,
            ..Counts::default()
        }
        .valid());
        let c = run(&[SECOND, FIRST]);
        assert!(c.warnings.contains("counter_reset"));
    }
    #[test]
    fn incremental_offsets_keep_baseline_and_retry_incomplete_tail() {
        let mut c = Collector::default();
        let mut state = FileState::default();
        let h = Path::new("/home/test");
        let codex = h.join(".codex");
        let first = format!("{CONTEXT}\n{FIRST}\n");
        c.scan_from(
            std::io::Cursor::new(&first),
            h,
            &codex,
            Instant::now(),
            &mut state,
        );
        assert_eq!(state.offset, first.len() as u64);
        c.scan_from(
            std::io::Cursor::new(SECOND),
            h,
            &codex,
            Instant::now(),
            &mut state,
        );
        assert_eq!(state.offset, first.len() as u64);
        c.scan_from(
            std::io::Cursor::new(format!("{SECOND}\n")),
            h,
            &codex,
            Instant::now(),
            &mut state,
        );
        assert_eq!(
            c.projects
                .values()
                .next()
                .unwrap()
                .daily
                .values()
                .next()
                .unwrap()
                .metrics
                .total_tokens,
            170
        );
    }
    #[test]
    fn exact_local_rates_require_context_and_never_guess() {
        let mut pricing = Pricing::default();
        pricing.models.insert(
            "openai/model-test".into(),
            Rate {
                input: Some(10.0),
                output: Some(50.0),
                cache_read: Some(1.0),
                canonical_slug: None,
            },
        );
        let counts = Counts {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 10,
            reasoning_output_tokens: 5,
        };
        assert!(
            (pricing
                .estimate("model-test", counts, Some(counts))
                .unwrap()
                - 0.00078)
                .abs()
                < 1e-10
        );
        assert!(pricing.estimate("missing", counts, Some(counts)).is_none());
        assert!(pricing.estimate("model-test", counts, None).is_none());
        let high = Counts {
            input_tokens: 300_000,
            ..counts
        };
        let cost = pricing.estimate("model-test", high, Some(high)).unwrap();
        assert!((cost - ((299_920.0 * 20.0 + 80.0 * 2.0 + 10.0 * 75.0) / 1e6)).abs() < 1e-10);
    }
    #[test]
    fn new_gpt6_models_use_official_rates_without_overwriting_existing_catalog() {
        let raw = std::env::temp_dir().join(format!(
            "quota-gpt6-pricing-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&raw).unwrap();
        let temp = fs::canonicalize(raw).unwrap();
        let catalog = temp.join("usage-prices.json");
        fs::write(
            &catalog,
            r#"{"models":{"openai/gpt-6-sol":{"in":3.0,"out":11.0,"cache_read":0.3}}}"#,
        )
        .unwrap();
        let pricing = Pricing::load(&temp, Some(&catalog));
        let counts = Counts {
            input_tokens: 200_000,
            cached_input_tokens: 50_000,
            output_tokens: 20_000,
            reasoning_output_tokens: 10_000,
        };
        let official = Pricing::load(&temp, None);
        for id in ["gpt-6.1-sol", "openai/gpt-6.1-sol"] {
            assert!((official.estimate(id, counts, Some(counts)).unwrap() - 0.505).abs() < 1e-10);
        }
        assert!(
            (official
                .estimate("gpt-6-sol", counts, Some(counts))
                .unwrap()
                - 0.51)
                .abs()
                < 1e-10
        );
        assert_eq!(pricing.models["openai/gpt-6-sol"].input, Some(3.0));
        assert!(
            (pricing.estimate("gpt-6-sol", counts, Some(counts)).unwrap() - 0.685).abs() < 1e-10
        );
        assert!(
            (pricing
                .estimate("gpt-6-luna", counts, Some(counts))
                .unwrap()
                - 0.0255)
                .abs()
                < 1e-10
        );
        assert!(pricing.estimate("gpt-6", counts, Some(counts)).is_none());
        assert!(pricing.estimate("gpt-6-luna", counts, None).is_none());
        let high = Counts {
            input_tokens: 300_000,
            ..counts
        };
        assert!((pricing.estimate("gpt-6-luna", high, Some(high)).unwrap() - 0.066).abs() < 1e-10);
        assert!((pricing.estimate("gpt-6.1-sol", high, Some(high)).unwrap() - 1.31).abs() < 1e-10);
        let exported = shared_pricing_export(&temp, &catalog).unwrap();
        assert_eq!(exported["models"]["openai/gpt-6.1-sol"]["cache_read"], 0.1);
        assert_eq!(exported["models"]["openai/gpt-6-luna"]["out"], 0.5);
        fs::create_dir_all(temp.join(".tokei")).unwrap();
        fs::write(
            temp.join(".tokei/pricing_overrides.json"),
            r#"{"models":{"openai/gpt-6-luna":{"out":999.0}}}"#,
        )
        .unwrap();
        let cloud_catalog = temp.join("cloud-pricing.json");
        fs::write(&cloud_catalog, serde_json::to_vec(&exported).unwrap()).unwrap();
        let peer = Pricing::load(&temp, Some(&cloud_catalog));
        assert_eq!(peer.models["openai/gpt-6-luna"].output, Some(0.5));
        assert!(
            (peer.estimate("gpt-6.1-sol", counts, Some(counts)).unwrap() - 0.505).abs() < 1e-10
        );
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn app_catalog_precedes_legacy_and_overrides_are_preserved() {
        let raw = std::env::temp_dir().join(format!(
            "quota-pricing-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(raw.join(".tokei")).unwrap();
        let temp = fs::canonicalize(raw).unwrap();
        let legacy = serde_json::json!({
            "_meta": {"updated_at": "legacy"},
            "models": {
                "model-test": {
                    "in": 1.0, "out": 2.0, "cache_read": 3.0,
                    "canonical_slug": "legacy-slug", "name": "legacy", "secret": "drop"
                }
            }
        });
        let app = serde_json::json!({
            "_meta": {"updated_at": "app"},
            "models": {
                "model-test": {
                    "in": 9.0, "out": 8.0, "cache_read": 7.0,
                    "canonical_slug": "app-slug", "name": "app"
                }
            }
        });
        let overrides = serde_json::json!({
            "models": {"model-test": {"out": 6.0}},
            "aliases": {"model-alias": "model-test"}
        });
        fs::write(
            temp.join(".tokei/pricing.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        fs::write(
            temp.join(".tokei/pricing_overrides.json"),
            serde_json::to_vec(&overrides).unwrap(),
        )
        .unwrap();
        let app_path = temp.join("app/usage-prices.json");
        fs::create_dir_all(app_path.parent().unwrap()).unwrap();
        fs::write(&app_path, serde_json::to_vec(&app).unwrap()).unwrap();

        let loaded = Pricing::load(&temp, Some(&app_path));
        assert_eq!(loaded.origin, PricingOrigin::App);
        let rate = loaded.models.get("model-test").unwrap();
        assert_eq!(rate.input, Some(9.0));
        assert_eq!(rate.output, Some(6.0));
        assert_eq!(rate.cache_read, Some(7.0));
        assert_eq!(
            loaded.aliases.get("model-alias"),
            Some(&"model-test".to_owned())
        );
        assert_eq!(
            loaded.meta.as_ref().unwrap().updated_at.as_deref(),
            Some("app")
        );

        fs::remove_file(&app_path).unwrap();
        let fallback = Pricing::load(&temp, Some(&app_path));
        assert_eq!(fallback.origin, PricingOrigin::Tokei);
        assert_eq!(fallback.models.get("model-test").unwrap().input, Some(1.0));
        assert_eq!(fallback.models.get("model-test").unwrap().output, Some(6.0));
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn legacy_catalog_is_sanitized_for_app_import() {
        let raw = std::env::temp_dir().join(format!(
            "quota-sanitize-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(raw.join(".tokei")).unwrap();
        let temp = fs::canonicalize(raw).unwrap();
        fs::write(
            temp.join(".tokei/pricing.json"),
            serde_json::to_vec(&serde_json::json!({
                "_meta": {"updated_at": "2026-09-10"},
                "models": {
                    "model-test": {
                        "in": 1.0, "out": 2.0, "cache_read": 3.0,
                        "canonical_slug": "model-test", "name": "drop", "secret": "drop"
                    },
                    "bad": {"in": -1.0, "out": 2.0, "cache_read": 3.0}
                },
                "aliases": {"model-alias": "model-test", "bad\n": "model-test"}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            temp.join(".tokei/pricing_overrides.json"),
            serde_json::to_vec(&serde_json::json!({
                "models": {"model-test": {"out": 4.0}},
                "aliases": {"override-alias": "model-test"}
            }))
            .unwrap(),
        )
        .unwrap();

        let value = sanitized_legacy_pricing(&temp).unwrap();
        assert_eq!(value["models"]["model-test"]["out"], 4.0);
        assert!(value["models"]["bad"].is_null());
        assert!(value["models"]["model-test"]["name"].is_null());
        assert!(value["models"]["model-test"]["secret"].is_null());
        assert_eq!(value["aliases"]["override-alias"], "model-test");

        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn oversized_body_is_skipped_without_losing_following_usage() {
        let text = format!(
            "{{\"type\":\"response_item\",\"payload\":{{\"body\":\"{}\"}}}}\n{CONTEXT}\n{FIRST}\n",
            "x".repeat(MAX_LINE + 10)
        );
        let mut c = Collector::default();
        c.scan(
            std::io::Cursor::new(text),
            Path::new("/home/test"),
            Path::new("/home/test/.codex"),
            Instant::now(),
        );
        assert!(c.warnings.contains("line_limit"));
        assert_eq!(c.projects.len(), 1);
    }
    #[test]
    fn worktree_common_dir_merges_without_running_git() {
        let temp = std::env::temp_dir().join(format!(
            "quota-project-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(temp.join("main/.git/worktrees/branch")).unwrap();
        fs::create_dir_all(temp.join("branch/src")).unwrap();
        fs::write(
            temp.join("branch/.git"),
            format!(
                "gitdir: {}\n",
                temp.join("main/.git/worktrees/branch").display()
            ),
        )
        .unwrap();
        fs::write(temp.join("main/.git/worktrees/branch/commondir"), "../..\n").unwrap();
        // macOS temporary directory may itself be a symlink; use its real root.
        let temp = fs::canonicalize(temp).unwrap();
        let h = Path::new("/home/test");
        let codex = h.join(".codex");
        assert_eq!(
            resolve_project(temp.join("main").to_str(), h, &codex),
            resolve_project(temp.join("branch/src").to_str(), h, &codex)
        );
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn discovery_reports_limits_and_orders_recent_dates_first() {
        let temp = std::env::temp_dir().join(format!(
            "quota-discovery-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(temp.join("2025")).unwrap();
        fs::create_dir_all(temp.join("2026")).unwrap();
        fs::write(temp.join("2025/old.jsonl"), "").unwrap();
        fs::write(temp.join("2026/new.jsonl"), "").unwrap();
        let temp = fs::canonicalize(temp).unwrap();
        let mut found = vec![];
        let mut warnings = HashSet::new();
        files(&temp, &mut found, 0, &mut warnings, &mut 20);
        assert_eq!(found[0], temp.join("2026/new.jsonl"));
        assert!(warnings.is_empty());
        files(&temp, &mut vec![], 0, &mut warnings, &mut 0);
        assert!(warnings.contains("directory_entry_limit"));
        files(&temp, &mut vec![], 6, &mut warnings, &mut 20);
        assert!(warnings.contains("directory_depth_limit"));
        files(
            &temp.join("missing"),
            &mut vec![],
            0,
            &mut warnings,
            &mut 20,
        );
        assert!(warnings.contains("directory_unavailable"));
        let meta = fs::metadata(temp.join("2026/new.jsonl")).unwrap();
        let state = FileState {
            source_length: Some(meta.len()),
            modified: Some(SystemTime::UNIX_EPOCH),
            identity: file_identity(&meta),
            ..FileState::default()
        };
        assert!(source_changed(&state, &meta));
        fs::create_dir_all(temp.join("sessions")).unwrap();
        fs::create_dir_all(temp.join("archived_sessions")).unwrap();
        let mut index = Index::default();
        index.collector.warnings.insert("metadata_limit".into());
        let result = collect_increment(&temp, &temp, &mut index);
        assert!(!result.warnings.iter().any(|w| w == "metadata_limit"));
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    #[ignore = "local authorized metadata only; emits no source data"]
    fn local_metadata_smoke() {
        let h = dirs::home_dir().unwrap();
        let started = Instant::now();
        let mut index = Index::default();
        for pass in 1..=4 {
            let c = collect_increment(&h, &h.join(".codex"), &mut index);
            assert!(c.scanned_files > 0);
            assert!(!c.projects.is_empty());
            let priced_periods = c
                .projects
                .iter()
                .flat_map(|p| p.daily.values())
                .filter(|d| d.metrics.estimated_cost_usd.is_some())
                .count();
            let relation_counts = c.tasks.iter().fold([0usize; 4], |mut counts, task| {
                counts[match task.relation {
                    TaskRelation::Root => 0,
                    TaskRelation::Subagent => 1,
                    TaskRelation::Fork => 2,
                    TaskRelation::Unlinked => 3,
                }] += 1;
                counts
            });
            println!("pass={} status={} scanned_files={} projects={} tasks={} roots={} subagents={} forks={} unlinked={} task_metadata_coverage={} priced_periods={} device_identity={} elapsed_ms={} warnings={:?}", pass, c.status, c.scanned_files, c.projects.len(), c.tasks.len(), relation_counts[0], relation_counts[1], relation_counts[2], relation_counts[3], c.task_metadata_coverage, priced_periods, c.device_id.is_some(), started.elapsed().as_millis(), c.warnings);
            if !c.warnings.iter().any(|w| w == "scan_limit") {
                break;
            }
        }
    }
}

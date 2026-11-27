use crate::{
    gemini_quota::{GeminiQuota, GeminiQuotaPool},
    tokei_usage, usage_sync,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

const FILE: &str = "gemini-quota-latest.json";
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub observed_at: DateTime<Utc>,
    pub gemini: Option<GeminiQuotaPool>,
    pub claude_gpt: Option<GeminiQuotaPool>,
}

impl Snapshot {
    pub fn valid(&self, now: DateTime<Utc>) -> bool {
        self.observed_at <= now + Duration::minutes(5)
            && self.observed_at >= now - Duration::days(7)
            && (self.gemini.is_some() || self.claude_gpt.is_some())
            && [&self.gemini, &self.claude_gpt]
                .into_iter()
                .flatten()
                .all(|pool| {
                    (pool.five_hour.is_some() || pool.weekly.is_some())
                        && [&pool.five_hour, &pool.weekly]
                            .into_iter()
                            .flatten()
                            .all(|window| {
                                (0.0..=100.0).contains(&window.remaining_percent)
                                    && window
                                        .resets_at
                                        .as_ref()
                                        .is_none_or(|at| DateTime::parse_from_rfc3339(at).is_ok())
                            })
                })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Peer {
    pub device_id: String,
    pub device_name: String,
    pub quota: Snapshot,
}

pub(crate) fn latest(data: &Path) -> Option<Snapshot> {
    let snapshot: Snapshot =
        serde_json::from_value(tokei_usage::read_json(&data.join(FILE), 2048).ok()?).ok()?;
    snapshot.valid(Utc::now()).then_some(snapshot)
}

pub(crate) fn remember(data: &Path, quota: &GeminiQuota) -> Result<(), String> {
    if !matches!(quota.status, "ok" | "stale") {
        return Ok(());
    }
    let Some(observed_at) = quota.observed_at.as_deref().and_then(|at| at.parse().ok()) else {
        return Ok(());
    };
    let snapshot = Snapshot {
        observed_at,
        gemini: quota.gemini.clone(),
        claude_gpt: quota.claude_gpt.clone(),
    };
    let _guard = SAVE_LOCK.lock().map_err(|_| "gemini_quota_save_failed")?;
    if snapshot.valid(Utc::now()) && latest(data).is_none_or(|old| old.observed_at < observed_at) {
        usage_sync::write_json(&data.join(FILE), &snapshot)?;
    }
    Ok(())
}

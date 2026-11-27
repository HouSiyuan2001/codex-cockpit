use crate::{
    claude_quota::{ClaudeQuota, ClaudeQuotaWindow},
    tokei_usage, usage_sync,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

const FILE: &str = "claude-quota-latest.json";
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub observed_at: DateTime<Utc>,
    pub five_hour: Option<ClaudeQuotaWindow>,
    pub seven_day: Option<ClaudeQuotaWindow>,
}

impl Snapshot {
    pub fn valid(&self, now: DateTime<Utc>) -> bool {
        self.observed_at <= now + Duration::minutes(5)
            && self.observed_at >= now - Duration::days(7)
            && (self.five_hour.is_some() || self.seven_day.is_some())
            && [&self.five_hour, &self.seven_day]
                .into_iter()
                .flatten()
                .all(|window| {
                    (0.0..=100.0).contains(&window.used_percent)
                        && window
                            .resets_at
                            .as_ref()
                            .is_none_or(|value| DateTime::parse_from_rfc3339(value).is_ok())
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
    let raw = tokei_usage::read_json(&data.join(FILE), 2048).ok()?;
    let snapshot: Snapshot = serde_json::from_value(raw).ok()?;
    snapshot.valid(Utc::now()).then_some(snapshot)
}

pub(crate) fn remember(data: &Path, quota: &ClaudeQuota) -> Result<(), String> {
    if quota.status != "ok" {
        return Ok(());
    }
    let Some(observed_at) = quota.observed_at.as_deref().and_then(|at| at.parse().ok()) else {
        return Ok(());
    };
    let snapshot = Snapshot {
        observed_at,
        five_hour: quota.five_hour.clone(),
        seven_day: quota.seven_day.clone(),
    };
    let _guard = SAVE_LOCK.lock().map_err(|_| "claude_quota_save_failed")?;
    if snapshot.valid(Utc::now()) && latest(data).is_none_or(|old| old.observed_at < observed_at) {
        usage_sync::write_json(&data.join(FILE), &snapshot)?;
    }
    Ok(())
}

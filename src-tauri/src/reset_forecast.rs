use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const STATUS_API_URL: &str = "https://codex-resets.com/api/v1/status";
const RESETS_API_URL: &str = "https://codex-resets.com/api/v1/resets?limit=100&order=desc";
const FORECAST_SOURCE_URL: &str = "https://codex-reset-risk-dashboard.xr08255920.workers.dev/";
const FUTURE_TOLERANCE_MINUTES: i64 = 5;
const DUPLICATE_WINDOW_MINUTES: i64 = 5;
const MAX_SCHEDULE_WINDOW_HOURS: i64 = 72;
const ANNOUNCEMENT_AUTHOR: &str = "thsottiaux";
const ANNOUNCEMENT_URL_PREFIX: &str = "https://x.com/thsottiaux/status/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskFactor {
    pub id: String,
    pub label: String,
    pub delta_pct: f64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetForecast {
    pub score: f64,
    pub window_hours: u8,
    pub fetched_at: String,
    pub reset_announced: bool,
    pub reset_at: Option<String>,
    pub source_url: String,
    pub tomorrow_risk_percent: f64,
    pub history_sample_count: u16,
    pub history_reset_dates: Vec<String>,
    pub risk_factors: Vec<RiskFactor>,
    pub active_watch: Option<ResetWatch>,
    pub watch_checked_at: String,
}

/// Public tracker metadata only. This is independent of our calibrated risk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWatch {
    pub signal_kind: String,
    pub level: String,
    pub reset_chance_percent: Option<u8>,
    pub observed_at: String,
    pub expires_at: String,
}

#[derive(Default, Deserialize)]
struct StatusResponse {
    #[serde(default)]
    data: StatusData,
}

#[derive(Default, Deserialize)]
struct StatusData {
    #[serde(default)]
    active_watch: Option<Watch>,
    #[serde(default)]
    scheduled_reset: Option<ScheduledReset>,
}

#[derive(Default, Deserialize)]
struct ResetListResponse {
    #[serde(default)]
    data: Vec<ResetRecord>,
}

#[derive(Default, Deserialize)]
struct ResetRecord {
    #[serde(default)]
    reset_type: String,
    #[serde(default)]
    announced_at: String,
}

#[derive(Default, Deserialize)]
struct Watch {
    #[serde(default)]
    reset_chance_percent: Option<u8>,
    #[serde(default)]
    level: String,
    #[serde(default)]
    observed_at: String,
    #[serde(default)]
    expires_at: String,
}

#[derive(Default, Deserialize)]
struct ScheduledReset {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    reset_type: String,
    #[serde(default)]
    announced_at: String,
    #[serde(default)]
    scheduled_for: String,
    #[serde(default)]
    source: AnnouncementSource,
}

#[derive(Default, Deserialize)]
struct AnnouncementSource {
    #[serde(rename = "type", default)]
    source_type: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    url: String,
}

fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn sanitize_history(
    records: impl IntoIterator<Item = ResetRecord>,
    as_of: DateTime<Utc>,
) -> Vec<DateTime<Utc>> {
    let mut dates: Vec<_> = records
        .into_iter()
        .filter(|record| record.reset_type == "regular")
        .filter_map(|record| parse_utc(&record.announced_at))
        .filter(|date| *date <= as_of)
        .collect();
    dates.sort_unstable();
    dates.dedup_by(|later, earlier| {
        (*later - *earlier).num_seconds() <= DUPLICATE_WINDOW_MINUTES * 60
    });
    dates
}

pub(crate) fn history_risk(dates: &[DateTime<Utc>], as_of: DateTime<Utc>) -> f64 {
    if dates.len() < 2 {
        return 10.0;
    }
    let decay = std::f64::consts::LN_2 / 30.0;
    let age_days = |date: DateTime<Utc>| (as_of - date).num_seconds() as f64 / 86_400.0;
    let weighted_count: f64 = dates
        .iter()
        .map(|date| (-decay * age_days(*date)).exp())
        .sum();
    let exposure = -(-decay * age_days(dates[0])).exp_m1() / decay;
    // Smooth sparse histories with one prior event per ten days of exposure.
    let rate = (weighted_count + 1.0) / (exposure + 10.0);
    round_tenth(-(-rate).exp_m1() * 100.0)
}

fn normalize(status: StatusResponse, resets: ResetListResponse) -> ResetForecast {
    normalize_at(status, resets, Utc::now())
}

fn active_watch(watch: Option<&Watch>, now: DateTime<Utc>) -> Option<ResetWatch> {
    let watch = watch?;
    let observed = parse_utc(&watch.observed_at)?;
    let expires = parse_utc(&watch.expires_at)?;
    if !matches!(watch.level.as_str(), "elevated" | "strong")
        || watch.reset_chance_percent.is_some_and(|value| value > 100)
        || observed > now + ChronoDuration::minutes(FUTURE_TOLERANCE_MINUTES)
        || expires <= now
        || expires <= observed
    {
        return None;
    }
    Some(ResetWatch {
        signal_kind: "watch".into(),
        level: watch.level.clone(),
        reset_chance_percent: watch.reset_chance_percent,
        observed_at: observed.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn scheduled_signal(scheduled: Option<&ScheduledReset>, now: DateTime<Utc>) -> Option<ResetWatch> {
    let scheduled = scheduled?;
    let announced = parse_utc(&scheduled.announced_at)?;
    let scheduled_for = parse_utc(&scheduled.scheduled_for)?;
    let expected_url = format!("{ANNOUNCEMENT_URL_PREFIX}{}", scheduled.id);
    if scheduled.status != "scheduled"
        || !matches!(scheduled.reset_type.as_str(), "regular" | "banked")
        || scheduled.id.is_empty()
        || scheduled.id.len() > 32
        || !scheduled
            .id
            .chars()
            .all(|character| character.is_ascii_digit())
        || scheduled.source.source_type != "x_post"
        || scheduled.source.author != ANNOUNCEMENT_AUTHOR
        || scheduled.source.url != expected_url
        || announced > now + ChronoDuration::minutes(FUTURE_TOLERANCE_MINUTES)
        || scheduled_for <= now
        || scheduled_for <= announced
        || scheduled_for > announced + ChronoDuration::hours(MAX_SCHEDULE_WINDOW_HOURS)
    {
        return None;
    }
    Some(ResetWatch {
        signal_kind: "scheduled".into(),
        level: "strong".into(),
        reset_chance_percent: None,
        observed_at: announced.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: scheduled_for.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn normalize_at(
    status: StatusResponse,
    resets: ResetListResponse,
    now: DateTime<Utc>,
) -> ResetForecast {
    let active_watch = scheduled_signal(status.data.scheduled_reset.as_ref(), now)
        .or_else(|| active_watch(status.data.active_watch.as_ref(), now));
    let dates = sanitize_history(resets.data, now);
    let tomorrow_risk_percent = history_risk(&dates, now);
    let history_reset_dates: Vec<_> = dates
        .iter()
        .rev()
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .collect();
    let risk_factors = if dates.len() >= 2 {
        vec![RiskFactor {
            id: "recent-regular-resets".into(),
            label: "近期实际重置".into(),
            delta_pct: tomorrow_risk_percent,
            note: "只统计直接刷新的重置记录，按 30 天半衰期加权。".into(),
        }]
    } else {
        Vec::new()
    };
    ResetForecast {
        score: tomorrow_risk_percent,
        window_hours: 24,
        fetched_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        reset_announced: false,
        reset_at: None,
        source_url: FORECAST_SOURCE_URL.into(),
        tomorrow_risk_percent,
        history_sample_count: history_reset_dates.len().min(u16::MAX as usize) as u16,
        history_reset_dates,
        risk_factors,
        active_watch,
        watch_checked_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

pub async fn fetch(client: &reqwest::Client) -> Option<ResetForecast> {
    let request = async {
        let status_request = async {
            client
                .get(STATUS_API_URL)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await?
                .error_for_status()
        };
        let resets_request = async {
            client
                .get(RESETS_API_URL)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await?
                .error_for_status()
        };
        let (status_response, resets_response) = tokio::join!(status_request, resets_request);
        let status = match status_response {
            Ok(response) => response.json::<StatusResponse>().await.unwrap_or_default(),
            Err(_) => StatusResponse::default(),
        };
        let resets = match resets_response {
            Ok(response) => response
                .json::<ResetListResponse>()
                .await
                .ok()
                .unwrap_or_default(),
            Err(_) => ResetListResponse::default(),
        };
        Some(normalize(status, resets))
    };

    tokio::time::timeout(Duration::from_secs(4), request)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::{ResetListResponse, StatusResponse};

    #[test]
    fn exposes_valid_public_watch_without_changing_calibration() {
        let now = super::parse_utc("2026-09-09T06:00:00Z").unwrap();
        for (level, chance) in [("elevated", "10"), ("strong", "70"), ("strong", "null")] {
            let status: StatusResponse = serde_json::from_str(&format!(
                r#"{{"data":{{"active_watch":{{"level":"{level}","reset_chance_percent":{chance},"observed_at":"2026-09-09T05:00:00Z","expires_at":"2026-09-10T05:00:00Z"}}}},"meta":{{"generated_at":"2026-09-09T05:59:00Z"}}}}"#
            )).unwrap();
            let result = super::normalize_at(status, ResetListResponse::default(), now);
            let watch = result.active_watch.unwrap();
            assert_eq!(watch.signal_kind, "watch");
            assert_eq!(watch.level, level);
            assert_eq!(watch.expires_at, "2026-09-10T05:00:00.000Z");
            assert_eq!(result.watch_checked_at, "2026-09-09T06:00:00.000Z");
        }
    }

    #[test]
    fn exposes_allowlisted_scheduled_announcement_without_changing_calibration() {
        let now = super::parse_utc("2026-10-11T03:00:00Z").unwrap();
        let status: StatusResponse = serde_json::from_str(
            r#"{"data":{"active_watch":null,"scheduled_reset":{"id":"2109045392684032299","status":"scheduled","reset_type":"regular","announced_at":"2026-10-10T22:16:20.000Z","scheduled_for":"2026-10-11T07:00:00.000Z","source":{"type":"x_post","author":"thsottiaux","url":"https://x.com/thsottiaux/status/2109045392684032299"}}},"meta":{"generated_at":"2026-10-11T02:56:46.506Z"}}"#,
        )
        .unwrap();
        let result = super::normalize_at(status, ResetListResponse::default(), now);
        let signal = result.active_watch.unwrap();

        assert_eq!(signal.signal_kind, "scheduled");
        assert_eq!(signal.level, "strong");
        assert_eq!(signal.reset_chance_percent, None);
        assert_eq!(signal.observed_at, "2026-10-10T22:16:20.000Z");
        assert_eq!(signal.expires_at, "2026-10-11T07:00:00.000Z");
        assert_eq!(result.tomorrow_risk_percent, 10.0);
        assert!(result
            .risk_factors
            .iter()
            .all(|factor| factor.id != "tracker-watch"));
    }

    #[test]
    fn rejects_expired_malformed_untrusted_and_unknown_schedules() {
        let now = super::parse_utc("2026-10-11T03:00:00Z").unwrap();
        let valid = || super::ScheduledReset {
            id: "2109045392684032299".into(),
            status: "scheduled".into(),
            reset_type: "regular".into(),
            announced_at: "2026-10-10T22:16:20Z".into(),
            scheduled_for: "2026-10-11T07:00:00Z".into(),
            source: super::AnnouncementSource {
                source_type: "x_post".into(),
                author: "thsottiaux".into(),
                url: "https://x.com/thsottiaux/status/2109045392684032299".into(),
            },
        };
        let mut candidates = Vec::new();
        let mut expired = valid();
        expired.scheduled_for = "2026-10-11T03:00:00Z".into();
        candidates.push(expired);
        let mut unknown = valid();
        unknown.status = "unknown".into();
        candidates.push(unknown);
        let mut malformed = valid();
        malformed.scheduled_for = "bad".into();
        candidates.push(malformed);
        let mut untrusted_author = valid();
        untrusted_author.source.author = "someone-else".into();
        candidates.push(untrusted_author);
        let mut untrusted_url = valid();
        untrusted_url.source.url = "https://example.com/2109045392684032299".into();
        candidates.push(untrusted_url);
        let mut mismatched_id = valid();
        mismatched_id.source.url = "https://x.com/thsottiaux/status/999".into();
        candidates.push(mismatched_id);
        let mut too_far = valid();
        too_far.scheduled_for = "2026-10-14T23:00:00Z".into();
        candidates.push(too_far);

        for candidate in candidates {
            assert!(super::scheduled_signal(Some(&candidate), now).is_none());
        }
        assert!(super::scheduled_signal(None, now).is_none());
    }

    #[test]
    fn suppresses_expired_future_unknown_and_malformed_watches() {
        let now = super::parse_utc("2026-09-09T06:00:00Z").unwrap();
        for (level, observed, expires, chance) in [
            ("strong", "2026-09-09T05:00:00Z", "2026-09-09T06:00:00Z", 70),
            ("strong", "2026-09-11T05:00:00Z", "2026-09-12T05:00:00Z", 70),
            (
                "unknown",
                "2026-09-09T05:00:00Z",
                "2026-09-10T05:00:00Z",
                70,
            ),
            ("strong", "bad", "2026-09-10T05:00:00Z", 70),
            ("strong", "2026-09-09T05:00:00Z", "bad", 70),
            (
                "strong",
                "2026-09-09T05:00:00Z",
                "2026-09-10T05:00:00Z",
                101,
            ),
        ] {
            let watch = super::Watch {
                level: level.into(),
                observed_at: observed.into(),
                expires_at: expires.into(),
                reset_chance_percent: Some(chance),
            };
            assert!(super::active_watch(Some(&watch), now).is_none());
        }
        assert!(super::active_watch(None, now).is_none());
        assert!(super::active_watch(Some(&super::Watch::default()), now).is_none());
    }

    #[test]
    fn forecasts_from_recent_regular_events_without_using_the_watch() {
        let now = super::parse_utc("2026-11-06T06:34:00Z").unwrap();
        let history = |extra| {
            serde_json::from_str::<ResetListResponse>(&format!(
                r#"{{"data":[
                {{"reset_type":"regular","announced_at":"2026-10-28T06:29:38Z"}},
                {{"reset_type":"regular","announced_at":"2026-10-26T07:00:00Z"}},
                {{"reset_type":"regular","announced_at":"2026-07-01T07:00:00Z"}},
                {{"reset_type":"banked","announced_at":"2026-11-01T23:27:20Z"}},
                {{"reset_type":"regular","announced_at":"2026-10-28T06:30:00Z"}},
                {{"reset_type":"regular","announced_at":"2026-11-07T07:00:00Z"}}
                {extra}
            ]}}"#
            ))
            .unwrap()
        };
        let baseline = super::normalize_at(StatusResponse::default(), history(""), now);
        let status =
            serde_json::from_str(r#"{"data":{"active_watch":{"reset_chance_percent":99}}}"#)
                .unwrap();
        let recent = super::normalize_at(
            status,
            history(r#",{"reset_type":"regular","announced_at":"2026-11-05T07:00:00Z"}"#),
            now,
        );

        assert_eq!(baseline.history_sample_count, 3);
        assert_eq!(baseline.tomorrow_risk_percent, 5.0);
        assert_eq!(recent.history_sample_count, 4);
        assert_eq!(recent.tomorrow_risk_percent, 6.8);
    }
}

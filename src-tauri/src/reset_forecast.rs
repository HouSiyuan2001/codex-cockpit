use chrono::{DateTime, Datelike, Duration as ChronoDuration, SecondsFormat, Utc, Weekday};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const STATUS_API_URL: &str = "https://codex-resets.com/api/v1/status";
const RESETS_API_URL: &str = "https://codex-resets.com/api/v1/resets?limit=100&order=desc";
const FORECAST_SOURCE_URL: &str = "https://codex-reset-risk-dashboard.xr08255920.workers.dev/";
const FUTURE_TOLERANCE_MINUTES: i64 = 5;
const DUPLICATE_WINDOW_MINUTES: i64 = 5;

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
    pub level: String,
    pub reset_chance_percent: Option<u8>,
    pub observed_at: String,
    pub expires_at: String,
}

#[derive(Default, Deserialize)]
struct StatusResponse {
    #[serde(default)]
    data: StatusData,
    #[serde(default)]
    meta: Meta,
}

#[derive(Default, Deserialize)]
struct StatusData {
    #[serde(default)]
    latest_reset: Option<ResetRecord>,
    #[serde(default)]
    active_watch: Option<Watch>,
}

#[derive(Default, Deserialize)]
struct ResetListResponse {
    #[serde(default)]
    data: Vec<ResetRecord>,
}

#[derive(Default, Deserialize)]
struct ResetRecord {
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
struct Meta {
    #[serde(default)]
    generated_at: String,
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
    values: impl IntoIterator<Item = String>,
    latest: Option<&ResetRecord>,
    as_of: DateTime<Utc>,
) -> Vec<String> {
    let mut parsed: Vec<DateTime<Utc>> = values
        .into_iter()
        .chain(latest.into_iter().map(|item| item.announced_at.clone()))
        .filter_map(|value| parse_utc(&value))
        .filter(|value| *value <= as_of + ChronoDuration::minutes(FUTURE_TOLERANCE_MINUTES))
        .collect();
    parsed.sort_by(|left, right| right.cmp(left));
    let mut clean: Vec<DateTime<Utc>> = Vec::with_capacity(parsed.len());
    for value in parsed {
        let duplicate = clean.last().is_some_and(|previous| {
            previous
                .signed_duration_since(value)
                .num_seconds()
                .unsigned_abs()
                <= (DUPLICATE_WINDOW_MINUTES * 60) as u64
        });
        if !duplicate {
            clean.push(value);
        }
    }
    clean
        .into_iter()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .collect()
}

fn calibrated_risk(
    dates: &[String],
    watch_percent: Option<u8>,
    as_of: DateTime<Utc>,
) -> (f64, Vec<RiskFactor>) {
    let target_weekday = (as_of + ChronoDuration::hours(24) + ChronoDuration::hours(8)).weekday();
    let base = if matches!(target_weekday, Weekday::Tue | Weekday::Sat) {
        70.0
    } else {
        10.0
    };
    let mut probability = base;
    let mut factors = vec![RiskFactor {
        id: "base".into(),
        label: "星期启发式基线".into(),
        delta_pct: base,
        note: "普通日 10%；周二、周六 70%。".into(),
    }];

    let parsed: Vec<DateTime<Utc>> = dates.iter().filter_map(|value| parse_utc(value)).collect();
    let age_days = parsed
        .first()
        .map(|latest| as_of.signed_duration_since(*latest).num_seconds().max(0) as f64 / 86_400.0)
        .unwrap_or(0.0);
    if !parsed.is_empty() && age_days <= 1.5 && probability < 40.0 {
        let delta = 40.0 - probability;
        probability += delta;
        factors.push(RiskFactor {
            id: "consecutive-reset".into(),
            label: "连续重置效应".into(),
            delta_pct: round_tenth(delta),
            note: "前一次 reset 后 36 小时内，将 24 小时风险至少抬到 40%。".into(),
        });
    }

    let mut ascending = parsed.clone();
    ascending.sort();
    let intervals: Vec<f64> = ascending
        .windows(2)
        .map(|pair| pair[1].signed_duration_since(pair[0]).num_seconds() as f64 / 86_400.0)
        .filter(|value| value.is_finite() && *value >= 0.25)
        .collect();
    if intervals.len() >= 5 {
        let at_risk = intervals.iter().filter(|value| **value >= age_days).count();
        let events = intervals
            .iter()
            .filter(|value| **value >= age_days && **value < age_days + 1.0)
            .count();
        let empirical = (events as f64 + 1.0) / (at_risk as f64 + 2.0) * 100.0;
        let delta = ((empirical - probability) * 0.25).clamp(-12.0, 12.0);
        probability += delta;
        factors.push(RiskFactor {
            id: "interval-hazard".into(),
            label: "历史间隔条件风险".into(),
            delta_pct: round_tenth(delta),
            note: format!("在已等待 {age_days:.1} 天的条件下，用清洗后的历史间隔校准。"),
        });
    }

    if parsed.len() >= 8 {
        let recent = parsed
            .iter()
            .filter(|value| as_of.signed_duration_since(**value).num_days() < 30)
            .count() as f64;
        let span_days = parsed
            .last()
            .map(|oldest| as_of.signed_duration_since(*oldest).num_seconds() as f64 / 86_400.0)
            .unwrap_or(0.0)
            .max(1.0);
        let long_term_30d = parsed.len() as f64 / span_days * 30.0;
        if recent > long_term_30d * 1.25 {
            probability += 12.0;
            factors.push(RiskFactor {
                id: "recent-regime".into(),
                label: "最近 30 天频率".into(),
                delta_pct: 12.0,
                note: "近期 reset 频率高于长期基线。".into(),
            });
        }

        let matching = parsed
            .iter()
            .filter(|value| (**value + ChronoDuration::hours(8)).weekday() == target_weekday)
            .count() as f64;
        let smoothed_share = (matching + 2.0) / (parsed.len() as f64 + 14.0);
        let delta = ((smoothed_share - 1.0 / 7.0) * 20.0).clamp(-6.0, 6.0);
        probability += delta;
        factors.push(RiskFactor {
            id: "weekday-empirical".into(),
            label: "历史星期分布".into(),
            delta_pct: round_tenth(delta),
            note: "用清洗后的 reset 星期分布做平滑校准。".into(),
        });
    }

    if let Some(watch) = watch_percent {
        let delta = (watch as f64 - probability) * 0.25;
        probability += delta;
        factors.push(RiskFactor {
            id: "tracker-watch".into(),
            label: "codex-resets.com watch".into(),
            delta_pct: round_tenth(delta),
            note: format!("上游公开 watch 信号约 {watch}%，以 25% 权重融入。"),
        });
    }
    (round_tenth(probability.clamp(2.0, 95.0)), factors)
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
        level: watch.level.clone(),
        reset_chance_percent: watch.reset_chance_percent,
        observed_at: observed.to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: expires.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn normalize_at(
    status: StatusResponse,
    resets: ResetListResponse,
    now: DateTime<Utc>,
) -> ResetForecast {
    let active_watch = active_watch(status.data.active_watch.as_ref(), now);
    let as_of = parse_utc(&status.meta.generated_at).unwrap_or_else(Utc::now);
    let history_reset_dates = sanitize_history(
        resets.data.into_iter().map(|item| item.announced_at),
        status.data.latest_reset.as_ref(),
        as_of,
    );
    let (tomorrow_risk_percent, risk_factors) = calibrated_risk(
        &history_reset_dates,
        status
            .data
            .active_watch
            .as_ref()
            .and_then(|value| value.reset_chance_percent),
        as_of,
    );
    ResetForecast {
        score: tomorrow_risk_percent,
        window_hours: 24,
        fetched_at: as_of.to_rfc3339_opts(SecondsFormat::Millis, true),
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
        let status = status_response.ok()?.json::<StatusResponse>().await.ok()?;
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
    use super::{normalize, ResetListResponse, StatusResponse};

    #[test]
    fn exposes_valid_public_watch_without_changing_calibration() {
        let now = super::parse_utc("2026-09-09T06:00:00Z").unwrap();
        for (level, chance) in [("elevated", "10"), ("strong", "70"), ("strong", "null")] {
            let status: StatusResponse = serde_json::from_str(&format!(
                r#"{{"data":{{"active_watch":{{"level":"{level}","reset_chance_percent":{chance},"observed_at":"2026-09-09T05:00:00Z","expires_at":"2026-09-10T05:00:00Z"}}}},"meta":{{"generated_at":"2026-09-09T05:59:00Z"}}}}"#
            )).unwrap();
            let result = super::normalize_at(status, ResetListResponse::default(), now);
            let watch = result.active_watch.unwrap();
            assert_eq!(watch.level, level);
            assert_eq!(watch.expires_at, "2026-09-10T05:00:00.000Z");
            assert_eq!(result.watch_checked_at, "2026-09-09T06:00:00.000Z");
        }
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
    fn prefers_the_public_watch_probability_and_keeps_history() {
        let status: StatusResponse = serde_json::from_str(
            r#"{"data":{"latest_reset":{"announced_at":"2026-08-13T01:01:37Z"},"active_watch":{"reset_chance_percent":58,"forecast_window":"within 24 hours"},"stats":{"total":43,"days_since_last":2.7,"avg_interval_days":7.9}},"meta":{"generated_at":"2026-08-15T16:43:13.430Z"}}"#,
        )
        .expect("Codex Resets status should parse");
        let resets: ResetListResponse = serde_json::from_str(
            r#"{"data":[{"announced_at":"2026-08-13T01:01:37Z"},{"announced_at":"2026-08-11T00:28:16Z"}]}"#,
        )
        .expect("Codex Resets list should parse");
        let forecast = normalize(status, resets);

        assert!(forecast.score > 10.0 && forecast.score < 80.0);
        assert!(forecast
            .risk_factors
            .iter()
            .any(|factor| factor.id == "tracker-watch"));
        assert_eq!(forecast.tomorrow_risk_percent, forecast.score);
        assert_eq!(forecast.window_hours, 24);
        assert_eq!(forecast.history_sample_count, 2);
        assert_eq!(
            forecast.source_url,
            "https://codex-reset-risk-dashboard.xr08255920.workers.dev/"
        );
        assert!(forecast.reset_at.is_none());
    }

    #[test]
    fn estimates_a_bounded_risk_from_history_when_no_watch_is_active() {
        let status: StatusResponse = serde_json::from_str(
            r#"{"data":{"latest_reset":null,"active_watch":null,"stats":{"total":43,"days_since_last":2.7,"avg_interval_days":7.9}},"meta":{"generated_at":"2026-08-15T16:43:13.430Z"}}"#,
        )
        .expect("status should parse");
        let resets: ResetListResponse = serde_json::from_str(
            r#"{"data":[{"announced_at":"2026-08-13T01:01:37Z"},{"announced_at":"2026-08-11T00:28:16Z"}]}"#,
        )
        .expect("history should parse");
        let forecast = normalize(status, resets);

        assert!(forecast.score > 0.0 && forecast.score < 100.0);
        assert_eq!(forecast.history_sample_count, 2);
        assert_eq!(forecast.window_hours, 24);
    }

    #[test]
    fn removes_future_and_near_duplicate_reset_records_before_calibration() {
        let status: StatusResponse = serde_json::from_str(
            r#"{"data":{"latest_reset":{"announced_at":"2026-08-27T16:35:05Z"},"active_watch":{"reset_chance_percent":80}},"meta":{"generated_at":"2026-08-29T08:29:33Z"}}"#,
        )
        .expect("status should parse");
        let resets: ResetListResponse = serde_json::from_str(
            r#"{"data":[{"announced_at":"2026-08-30T07:00:00Z"},{"announced_at":"2026-08-27T16:35:05Z"},{"announced_at":"2026-08-27T16:35:00Z"},{"announced_at":"2026-08-24T00:46:51Z"}]}"#,
        )
        .expect("history should parse");
        let forecast = normalize(status, resets);

        assert_eq!(forecast.history_sample_count, 2);
        assert_eq!(forecast.history_reset_dates[0], "2026-08-27T16:35:05.000Z");
        assert_eq!(forecast.history_reset_dates[1], "2026-08-24T00:46:51.000Z");
        assert!(forecast
            .history_reset_dates
            .iter()
            .all(|value| !value.starts_with("2026-08-30")));
    }
}

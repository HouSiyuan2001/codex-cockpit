//! Public Claude subscription reset catalog (claude-resets.com, CC BY 4.0).
use crate::website_reset_probability::read_json;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const CATALOG_URL: &str = "https://claude-resets.com/api/resets";
const SOURCE_URL: &str = "https://claude-resets.com/";
const ANNOUNCEMENT_HOURS: i64 = 48;
const SOURCE_ACCOUNTS: &[&str] = &["ClaudeDevs", "bcherny", "lydiahallie"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeResetForecast {
    checked_at: String,
    notice: Option<ClaudeResetNotice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeResetNotice {
    observed_at: String,
    expires_at: String,
    announcement_url: String,
}

#[derive(Deserialize)]
struct Catalog {
    providers: Providers,
}

#[derive(Deserialize)]
struct Providers {
    claude: Claude,
}

#[derive(Deserialize)]
struct Claude {
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    date: String,
    kind: String,
    reset_type: Option<String>,
    usable_until: Option<String>,
    scope: Option<String>,
    url: Option<String>,
    verification: Option<String>,
}

fn parse(value: &str) -> Option<DateTime<Utc>> {
    value.parse().ok()
}

fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn original_post(event: &Event) -> Option<&str> {
    let url = event.url.as_deref()?;
    (!event.id.is_empty()
        && event.id.len() <= 32
        && event.id.bytes().all(|byte| byte.is_ascii_digit())
        && SOURCE_ACCOUNTS
            .iter()
            .any(|account| url == format!("https://x.com/{account}/status/{}", event.id)))
    .then_some(url)
}

fn plan_key(plan: Option<&str>) -> Option<&'static str> {
    let plan = plan?.to_ascii_lowercase();
    let words = plan.split(|ch: char| !ch.is_ascii_alphabetic());
    words
        .filter_map(|word| match word {
            "pro" => Some("pro"),
            "max" => Some("max"),
            "ultra" => Some("ultra"),
            "team" => Some("team"),
            "enterprise" => Some("enterprise"),
            "free" => Some("free"),
            _ => None,
        })
        .next()
}

fn applies(scope: Option<&str>, plan: Option<&str>) -> bool {
    let scope = scope.unwrap_or("").trim().to_ascii_lowercase();
    if matches!(
        scope.as_str(),
        "all" | "all users" | "all plans" | "all subscribers"
    ) {
        return true;
    }
    if scope == "paid plans" {
        return plan.is_some_and(|key| key != "free") || plan.is_none();
    }
    // Don't claim an account was among a cohort affected by an incident.
    if scope.contains("affected") {
        return false;
    }
    let words: Vec<_> = scope.split(|ch: char| !ch.is_ascii_alphabetic()).collect();
    plan.map_or_else(
        || {
            scope.is_empty()
                || words
                    .iter()
                    .any(|word| matches!(*word, "pro" | "max" | "ultra" | "team" | "enterprise"))
        },
        |key| words.contains(&key),
    )
}

fn normalize(catalog: Catalog, plan: Option<&str>, now: DateTime<Utc>) -> ClaudeResetForecast {
    let plan = plan_key(plan);
    let mut latest = None;
    for event in catalog.providers.claude.events {
        let curated = event.verification.as_deref() == Some("curated");
        let banked = event.reset_type.as_deref() == Some("banked");
        if event.kind != "reset"
            || !matches!(
                event.reset_type.as_deref(),
                None | Some("regular" | "banked")
            )
            || (!curated && event.verification.as_deref() != Some("provisional"))
        {
            continue;
        }
        let Some(date) = parse(&event.date).filter(|date| *date <= now) else {
            continue;
        };
        let post = original_post(&event);
        if !curated && post.is_none() {
            continue;
        }
        if !applies(event.scope.as_deref(), plan) {
            continue;
        }
        let reminder_end = date + ChronoDuration::hours(ANNOUNCEMENT_HOURS);
        let expires = match (banked, event.usable_until.as_deref()) {
            (true, Some(raw)) => parse(raw).map(|until| until.min(reminder_end)),
            _ => Some(reminder_end),
        };
        if let Some(expires) = expires.filter(|until| *until > now) {
            if latest.as_ref().is_none_or(|(previous, _)| date > *previous) {
                latest = Some((
                    date,
                    ClaudeResetNotice {
                        observed_at: iso(date),
                        expires_at: iso(expires),
                        announcement_url: post.unwrap_or(SOURCE_URL).into(),
                    },
                ));
            }
        }
    }
    ClaudeResetForecast {
        checked_at: iso(now),
        notice: latest.map(|(_, notice)| notice),
    }
}

pub async fn fetch(client: &reqwest::Client, plan: Option<&str>) -> Option<ClaudeResetForecast> {
    tokio::time::timeout(Duration::from_secs(4), async {
        let catalog = read_json::<Catalog>(client, CATALOG_URL).await?;
        Some(normalize(catalog, plan, Utc::now()))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(plan: Option<&str>, now: &str) -> ClaudeResetForecast {
        let catalog = serde_json::from_str(r#"{"providers":{"claude":{"events":[
            {"id":"100","date":"2026-08-25T18:00:00Z","kind":"reset","scope":"all","verification":"curated","note":"Reset 5-hour and weekly limits"},
            {"id":"101","date":"2026-09-01T18:00:00Z","kind":"reset","scope":"all","verification":"curated","note":"Reset 5-hour and weekly limits"},
            {"id":"102","date":"2026-09-04T18:00:00Z","kind":"reset","scope":"Max","verification":"curated","note":"Reset weekly limits"},
            {"id":"103","date":"2026-11-08T18:00:00Z","kind":"reset","scope":"all","verification":"curated","note":"Reset 5-hour limits"},
            {"id":"104","date":"2026-11-09T19:21:45Z","kind":"policy","scope":"all","verification":"curated","note":"Raised weekly limits"},
            {"id":"105","date":"2026-11-10T21:59:58Z","kind":"reset","resetType":"banked","scope":"Pro, Max, Ultra + Team","usableUntil":"2026-12-10T22:00:00Z","verification":"curated","note":"Reset all usage limits","url":"https://x.com/ClaudeDevs/status/105"},
            {"id":"106","date":"2026-11-11T21:59:58Z","kind":"reset","scope":"all","verification":"provisional","url":"https://x.com/ClaudeDevs/status/107"},
            {"id":"107","date":"2026-11-13T21:59:58Z","kind":"reset","scope":"all","verification":"curated","note":"Reset 5-hour and weekly limits","url":"https://x.com/ClaudeDevs/status/107"}
        ]}}}"#).unwrap();
        normalize(catalog, plan, parse(now).unwrap())
    }

    #[test]
    fn banked_announcement_expires_even_if_the_grant_is_still_claimable() {
        let max = result(Some("max_20x"), "2026-11-12T21:59:57Z");
        let notice = max.notice.unwrap();
        assert_eq!(
            notice.announcement_url,
            "https://x.com/ClaudeDevs/status/105"
        );
        assert_eq!(notice.expires_at, "2026-11-12T21:59:58.000Z");
        assert!(result(Some("enterprise"), "2026-11-12T21:59:57Z")
            .notice
            .is_none());
        assert!(result(Some("max"), "2026-11-12T21:59:58Z").notice.is_none());
    }

    #[test]
    fn rejects_mismatched_links_for_provisional_news() {
        let result = result(None, "2026-11-12T21:59:57Z");
        assert_eq!(
            result.notice.unwrap().announcement_url,
            "https://x.com/ClaudeDevs/status/105"
        );
    }
}

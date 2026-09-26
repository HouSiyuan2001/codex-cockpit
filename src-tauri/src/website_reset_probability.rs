//! Read the same public community ballot used by codex-resets.com's heading.
//! This is not the v1 API's `reset_chance_percent` or a calibrated 24h hazard.
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

const WATCH_URL: &str = "https://codex-resets.com/api/resets";
const VOTES_URL: &str = "https://codex-resets.com/api/watch/votes";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteResetProbability {
    level: String,
    reset_chance_percent: Option<u8>,
    observed_at: String,
    expires_at: String,
    checked_at: String,
    episode_id: String,
}

#[derive(Deserialize)]
struct WebsiteResponse {
    watch: Option<WebsiteWatch>,
}

#[derive(Deserialize)]
struct WebsiteWatch {
    level: String,
    episode_id: String,
    observed_at: String,
    expires_at: String,
}

#[derive(Deserialize)]
struct Votes {
    episode_id: String,
    yes: u64,
    no: u64,
}

fn normalize(
    response: WebsiteResponse,
    votes: Votes,
    now: DateTime<Utc>,
) -> Option<WebsiteResetProbability> {
    let watch = response.watch?;
    let observed = DateTime::parse_from_rfc3339(&watch.observed_at).ok()?;
    let expires = DateTime::parse_from_rfc3339(&watch.expires_at).ok()?;
    if !matches!(watch.level.as_str(), "elevated" | "strong")
        || watch.episode_id.is_empty()
        || watch.episode_id != votes.episode_id
        || observed > now + ChronoDuration::minutes(5)
        || expires <= now
        || expires <= observed
        || votes.yes > MAX_SAFE_INTEGER
        || votes.no > MAX_SAFE_INTEGER
    {
        return None;
    }
    let total = votes.yes.checked_add(votes.no)?;
    // Exactly the site's Math.round(yes / (yes + no) * 100), including 0 and 100.
    let percent = (total > 0).then(|| (votes.yes as f64 / total as f64 * 100.0).round() as u8);
    Some(WebsiteResetProbability {
        level: watch.level,
        reset_chance_percent: percent,
        observed_at: observed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: expires
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        checked_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        episode_id: watch.episode_id,
    })
}

async fn read_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Option<T> {
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

pub async fn fetch(client: &reqwest::Client) -> Option<WebsiteResetProbability> {
    tokio::time::timeout(Duration::from_secs(4), async {
        let (watch, votes) = tokio::join!(
            read_json::<WebsiteResponse>(client, WATCH_URL),
            read_json::<Votes>(client, VOTES_URL)
        );
        normalize(watch?, votes?, Utc::now())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> WebsiteResponse {
        serde_json::from_str(r#"{"watch":{"episode_id":"episode-a","level":"elevated","observed_at":"2026-09-11T06:39:40Z","expires_at":"2026-09-14T07:00:00Z","reset_chance":60}}"#).unwrap()
    }
    fn now() -> DateTime<Utc> {
        "2026-09-11T07:00:00Z".parse().unwrap()
    }
    fn votes(yes: u64, no: u64) -> Votes {
        Votes {
            episode_id: "episode-a".into(),
            yes,
            no,
        }
    }

    #[test]
    fn matches_the_website_ballot_instead_of_the_sixty_percent_api_hint() {
        for (yes, no, percent) in [
            (83, 17, 83),
            (269, 50, 84),
            (360, 63, 85),
            (1, 7, 13),
            (0, 5, 0),
            (5, 0, 100),
        ] {
            assert_eq!(
                normalize(watch(), votes(yes, no), now())
                    .unwrap()
                    .reset_chance_percent,
                Some(percent)
            );
        }
    }

    #[test]
    fn zero_votes_remain_unknown() {
        assert_eq!(
            normalize(watch(), votes(0, 0), now())
                .unwrap()
                .reset_chance_percent,
            None
        );
    }

    #[test]
    fn rejects_cross_episode_expired_future_and_unsafe_counts() {
        let mut other = votes(83, 17);
        other.episode_id = "episode-b".into();
        assert!(normalize(watch(), other, now()).is_none());
        assert!(normalize(
            watch(),
            votes(83, 17),
            "2026-09-14T07:00:00Z".parse().unwrap()
        )
        .is_none());
        assert!(normalize(
            watch(),
            votes(83, 17),
            "2026-09-10T07:00:00Z".parse().unwrap()
        )
        .is_none());
        assert!(normalize(watch(), votes(u64::MAX, 1), now()).is_none());
        assert!(normalize(WebsiteResponse { watch: None }, votes(83, 17), now()).is_none());
        assert!(
            serde_json::from_str::<Votes>(r#"{"episode_id":"episode-a","yes":-1,"no":2}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Votes>(r#"{"episode_id":"episode-a","yes":1.5,"no":2}"#)
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "read-only public website network check; requires an active ballot"]
    async fn live_website_ballot_smoke() {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("QuotaFloat/0.1")
            .build()
            .unwrap();
        let result = fetch(&client)
            .await
            .expect("active website ballot should be readable");
        println!("{}", serde_json::to_string(&result).unwrap());
        assert!(result.reset_chance_percent.is_some());
    }
}

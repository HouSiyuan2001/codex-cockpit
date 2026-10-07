//! Read codex-resets.com's public watch signal, independently of its vote API.
//! This is a third-party forecast, not an official reset or calibrated hazard.
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

const WATCH_URL: &str = "https://codex-resets.com/api/resets";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

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
    episode_id: Option<String>,
    tweet_id: Option<String>,
    observed_at: String,
    expires_at: String,
}

fn normalize(response: WebsiteResponse, now: DateTime<Utc>) -> Option<WebsiteResetProbability> {
    let watch = response.watch?;
    let observed = DateTime::parse_from_rfc3339(&watch.observed_at).ok()?;
    let expires = DateTime::parse_from_rfc3339(&watch.expires_at).ok()?;
    if !matches!(watch.level.as_str(), "elevated" | "strong")
        || observed > now + ChronoDuration::minutes(5)
        || expires <= now
        || expires <= observed
    {
        return None;
    }
    // The public watch can omit episode_id. Keep a stable, bounded identity for
    // the frontend's freshness check without forwarding the watch text or URL.
    let episode_id = [watch.episode_id.as_deref(), watch.tweet_id.as_deref()]
        .into_iter()
        .flatten()
        .find(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .unwrap_or_else(|| observed.to_rfc3339());
    Some(WebsiteResetProbability {
        level: watch.level,
        // reset_chance is a different signal; do not present it as vote percent.
        reset_chance_percent: None,
        observed_at: observed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        expires_at: expires
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        checked_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        episode_id,
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
        let watch = read_json::<WebsiteResponse>(client, WATCH_URL).await?;
        normalize(watch, Utc::now())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> WebsiteResponse {
        serde_json::from_str(r#"{"watch":{"tweet_id":"manual-event-a","level":"strong","observed_at":"2026-09-11T06:39:40Z","expires_at":"2026-09-14T07:00:00Z","reset_chance":null}}"#).unwrap()
    }
    fn now() -> DateTime<Utc> {
        "2026-09-11T07:00:00Z".parse().unwrap()
    }
    #[test]
    fn accepts_current_watch_without_votes_or_episode_id() {
        let result = normalize(watch(), now()).unwrap();
        assert_eq!(result.level, "strong");
        assert_eq!(result.episode_id, "manual-event-a");
        assert_eq!(result.reset_chance_percent, None);
    }

    #[test]
    fn accepts_legacy_episode_and_falls_back_to_observed_time() {
        let mut legacy = watch();
        legacy.watch.as_mut().unwrap().episode_id = Some("episode-a".into());
        assert_eq!(normalize(legacy, now()).unwrap().episode_id, "episode-a");
        let mut no_id = watch();
        no_id.watch.as_mut().unwrap().tweet_id = None;
        assert_eq!(
            normalize(no_id, now()).unwrap().episode_id,
            "2026-09-11T06:39:40+00:00"
        );
    }

    #[test]
    fn rejects_expired_future_and_unrecognized_levels() {
        assert!(normalize(watch(), "2026-09-14T07:00:00Z".parse().unwrap()).is_none());
        assert!(normalize(watch(), "2026-09-10T07:00:00Z".parse().unwrap()).is_none());
        assert!(normalize(WebsiteResponse { watch: None }, now()).is_none());
        let mut unknown = watch();
        unknown.watch.as_mut().unwrap().level = "none".into();
        assert!(normalize(unknown, now()).is_none());
    }

    #[tokio::test]
    #[ignore = "read-only public website network check; requires an active watch"]
    async fn live_website_watch_smoke() {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("QuotaFloat/0.1")
            .build()
            .unwrap();
        let result = fetch(&client)
            .await
            .expect("active website watch should be readable");
        println!("{}", serde_json::to_string(&result).unwrap());
        assert!(matches!(result.level.as_str(), "elevated" | "strong"));
    }
}

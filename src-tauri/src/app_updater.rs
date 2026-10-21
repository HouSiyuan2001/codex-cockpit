use serde::Serialize;
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: u32,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[cfg(any(target_os = "linux", test))]
fn linux_package_supports_updates(bundle: Option<tauri::utils::config::BundleType>) -> bool {
    matches!(bundle, Some(tauri::utils::config::BundleType::AppImage))
}

fn update_endpoint(repository: &str, channel: &str) -> Result<String, String> {
    if !matches!(channel, "stable" | "beta") {
        return Err("Unknown update channel".into());
    }
    let parts: Vec<_> = repository.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        })
    {
        return Err("This build has no update source configured".into());
    }
    Ok(format!(
        "https://github.com/{repository}/releases/download/updates-{channel}/latest.json"
    ))
}

#[tauri::command]
pub async fn check_cockpit_update(
    webview: Webview,
    channel: String,
) -> Result<Option<UpdateMetadata>, String> {
    // The Linux feed contains AppImages only. Do not offer one to a system
    // package installation or overwrite an unpackaged development executable.
    #[cfg(target_os = "linux")]
    if !linux_package_supports_updates(tauri::utils::platform::bundle_type()) {
        return Err("此 Linux 安装请从版本页面下载对应安装包，并通过包管理器更新；应用内更新仅支持 AppImage。 / Use the package manager to update this Linux installation; in-app updates require AppImage.".into());
    }
    let endpoint = update_endpoint(
        option_env!("COCKPIT_UPDATES_REPOSITORY").unwrap_or("HouSiyuan2001/codex-cockpit"),
        &channel,
    )?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![endpoint
            .parse()
            .map_err(|_| "Invalid update source")?])
        .map_err(|_| "Invalid update source")?
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Update verification is not configured")?;
    let update = updater.check().await.map_err(|_| "无法读取更新来源：仓库可能仍为私有，或网络暂不可用。可打开版本页面手动下载。 / Update source unavailable; repository may be private or offline.")?;
    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_update_feed_is_only_offered_to_appimages() {
        use tauri::utils::config::BundleType;
        assert!(linux_package_supports_updates(Some(BundleType::AppImage)));
        assert!(!linux_package_supports_updates(Some(BundleType::Deb)));
        assert!(!linux_package_supports_updates(Some(BundleType::Rpm)));
        assert!(!linux_package_supports_updates(None));
    }
    #[test]
    fn endpoints_keep_channels_separate_and_reject_unconfigured_builds() {
        assert!(update_endpoint("", "stable").is_err());
        assert!(update_endpoint("owner/repo", "../stable").is_err());
        assert!(update_endpoint("https://example.org", "stable").is_err());
        assert!(update_endpoint("owner/..", "stable").is_err());
        assert_eq!(
            update_endpoint("owner/updates", "beta").unwrap(),
            "https://github.com/owner/updates/releases/download/updates-beta/latest.json"
        );
    }
}

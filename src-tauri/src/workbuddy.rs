use crate::models::ProviderSnapshot;

#[cfg(windows)]
mod windows {
    use super::*;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    use rusqlite::Connection;
    use serde::Deserialize;
    use serde_json::Value;
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB},
    };

    const ENDPOINT: &str = "https://copilot.tencent.com";
    const PRODUCT_CODE: &str = "p_tcaca";
    const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
    const SECRET_KEY: &str = r#"secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}"#;

    #[derive(Deserialize)]
    struct SecretBlob {
        data: Vec<u8>,
    }

    struct Auth {
        access_token: String,
        user_id: String,
        account_type: Option<String>,
        enterprise_id: Option<String>,
        domain: Option<String>,
    }

    fn root() -> Option<PathBuf> {
        dirs::data_dir()
            .map(|roaming| roaming.join("WorkBuddy"))
            .filter(|root| root.join("Local State").exists())
    }

    fn decrypt_dpapi(input: &[u8]) -> Result<Vec<u8>, &'static str> {
        let source = CRYPT_INTEGER_BLOB {
            cbData: input.len() as u32,
            pbData: input.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("WorkBuddy credentials could not be unlocked for this Windows user.");
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe { LocalFree(output.pbData.cast()) };
        Ok(bytes)
    }

    fn encryption_key(root: &Path) -> Result<Vec<u8>, &'static str> {
        let raw = fs::read(root.join("Local State"))
            .map_err(|_| "WorkBuddy login data is unavailable.")?;
        if raw.len() > 1024 * 1024 {
            return Err("WorkBuddy login data is too large.");
        }
        let state: Value = serde_json::from_slice(&raw)
            .map_err(|_| "WorkBuddy login data has an unsupported format.")?;
        let encoded = state
            .pointer("/os_crypt/encrypted_key")
            .and_then(Value::as_str)
            .ok_or("WorkBuddy encryption key is missing.")?;
        let encrypted = STANDARD
            .decode(encoded)
            .map_err(|_| "WorkBuddy encryption key is invalid.")?;
        decrypt_dpapi(encrypted.strip_prefix(b"DPAPI").unwrap_or(&encrypted))
    }

    fn read_secret(root: &Path, key: &[u8]) -> Result<Value, &'static str> {
        let database = root.join("User").join("globalStorage").join("state.vscdb");
        let connection =
            Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "WorkBuddy account cache is unavailable.")?;
        let raw: String = connection
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?1",
                [SECRET_KEY],
                |row| row.get(0),
            )
            .map_err(|_| "Sign in to WorkBuddy to view quota.")?;
        let secret: SecretBlob = serde_json::from_str(&raw)
            .map_err(|_| "WorkBuddy account cache has an unsupported format.")?;
        if secret.data.len() < 31 || &secret.data[..3] != b"v10" {
            return Err("WorkBuddy uses an unsupported credential format.");
        }
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| "WorkBuddy encryption key is invalid.")?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&secret.data[3..15]), &secret.data[15..])
            .map_err(|_| "WorkBuddy credentials could not be decrypted.")?;
        serde_json::from_slice(&plain)
            .map_err(|_| "WorkBuddy account data has an unsupported format.")
    }

    fn string_at(value: &Value, pointers: &[&str]) -> Option<String> {
        pointers
            .iter()
            .find_map(|pointer| value.pointer(pointer)?.as_str().map(str::to_owned))
    }

    fn load_auth() -> Result<Auth, &'static str> {
        let root = root().ok_or("WorkBuddy is not installed for this user.")?;
        let key = encryption_key(&root)?;
        let value = read_secret(&root, &key)?;
        Ok(Auth {
            access_token: string_at(&value, &["/auth/accessToken", "/accessToken"])
                .ok_or("WorkBuddy login has expired.")?,
            user_id: string_at(&value, &["/account/uid", "/uid"])
                .ok_or("WorkBuddy user ID is missing.")?,
            account_type: string_at(&value, &["/account/type", "/type"]),
            enterprise_id: string_at(&value, &["/account/enterpriseId", "/enterpriseId"]),
            domain: string_at(&value, &["/auth/domain", "/domain"]),
        })
    }

    fn insert_sensitive(
        headers: &mut HeaderMap,
        name: HeaderName,
        value: &str,
    ) -> Result<(), &'static str> {
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| "WorkBuddy login data contains an invalid header.")?;
        value.set_sensitive(true);
        headers.insert(name, value);
        Ok(())
    }

    fn headers(auth: &Auth) -> Result<HeaderMap, &'static str> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        insert_sensitive(
            &mut headers,
            AUTHORIZATION,
            &format!("Bearer {}", auth.access_token),
        )?;
        insert_sensitive(
            &mut headers,
            HeaderName::from_static("x-user-id"),
            &auth.user_id,
        )?;
        if let Some(enterprise_id) = auth.enterprise_id.as_deref() {
            insert_sensitive(
                &mut headers,
                HeaderName::from_static("x-enterprise-id"),
                enterprise_id,
            )?;
            insert_sensitive(
                &mut headers,
                HeaderName::from_static("x-tenant-id"),
                enterprise_id,
            )?;
        }
        if let Some(domain) = auth.domain.as_deref() {
            insert_sensitive(&mut headers, HeaderName::from_static("x-domain"), domain)?;
        }
        Ok(headers)
    }

    fn number(value: &Value, key: &str) -> Option<f64> {
        let value = value.get(key)?;
        value
            .as_f64()
            .or_else(|| value.as_i64().map(|number| number as f64))
            .or_else(|| value.as_str()?.parse().ok())
    }

    fn personal_accounts(value: &Value) -> Option<&Vec<Value>> {
        [
            "/data/data/Response/Data/Accounts",
            "/data/Response/Data/Accounts",
            "/Response/Data/Accounts",
            "/data/Accounts",
            "/Accounts",
        ]
        .iter()
        .find_map(|pointer| value.pointer(pointer)?.as_array())
    }

    fn friendly_plan(account_type: Option<&str>, package_code: Option<&str>) -> String {
        let source = package_code.or(account_type).unwrap_or("personal");
        let lower = source.to_ascii_lowercase();
        if lower.contains("ultimate") {
            "Ultimate".into()
        } else if lower.contains("exclusive") || lower.contains("enterprise") {
            "Enterprise".into()
        } else if lower.contains("pro") {
            "Pro".into()
        } else if lower.contains("free") {
            "Free".into()
        } else {
            "Personal".into()
        }
    }

    fn parse_personal(
        value: &Value,
        account_type: Option<&str>,
    ) -> Result<ProviderSnapshot, &'static str> {
        let accounts =
            personal_accounts(value).ok_or("WorkBuddy response is missing personal quota data.")?;
        let mut remaining = 0.0;
        let mut total = 0.0;
        let mut best_package: Option<(&str, f64)> = None;
        for account in accounts {
            let item_total = number(account, "CycleCapacitySizePrecise").unwrap_or(0.0);
            let item_remaining = number(account, "CycleCapacityRemainPrecise").unwrap_or(0.0);
            if item_total <= 0.0 && item_remaining <= 0.0 {
                continue;
            }
            total += item_total.max(0.0);
            remaining += item_remaining.max(0.0);
            if let Some(code) = account.get("PackageCode").and_then(Value::as_str) {
                if best_package.is_none_or(|(_, capacity)| item_total > capacity) {
                    best_package = Some((code, item_total));
                }
            }
        }
        if total <= 0.0 && remaining <= 0.0 {
            return Err("WorkBuddy has no active personal quota package.");
        }
        Ok(ProviderSnapshot {
            provider: "workbuddy".into(),
            display_name: "WORKBUDDY".into(),
            plan: Some(friendly_plan(
                account_type,
                best_package.map(|(code, _)| code),
            )),
            short_window: None,
            weekly_window: None,
            monthly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            balance_remaining: Some(remaining),
            balance_unit: Some("credits".into()),
            rate_limit_snapshot: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: "ok".into(),
            message: None,
        })
    }

    fn enterprise_usage(value: &Value) -> Option<&Value> {
        [
            "/data/data",
            "/data/Response/Data",
            "/data",
            "/Response/Data",
        ]
        .iter()
        .find_map(|pointer| {
            let candidate = value.pointer(pointer)?;
            candidate.get("limitNum").map(|_| candidate)
        })
        .or_else(|| value.get("limitNum").map(|_| value))
    }

    fn parse_enterprise(value: &Value) -> Result<ProviderSnapshot, &'static str> {
        let usage = enterprise_usage(value)
            .ok_or("WorkBuddy response is missing enterprise quota data.")?;
        let limit =
            number(usage, "limitNum").ok_or("WorkBuddy enterprise quota limit is missing.")?;
        let used = number(usage, "credit").unwrap_or(0.0);
        if limit < 0.0 {
            return Ok(ProviderSnapshot {
                provider: "workbuddy".into(),
                display_name: "WORKBUDDY".into(),
                plan: Some("Enterprise Unlimited".into()),
                short_window: None,
                weekly_window: None,
                monthly_window: None,
                reset_credits: None,
                reset_credit_expires_at: Vec::new(),
                balance_remaining: Some(0.0),
                balance_unit: Some("unlimited".into()),
                rate_limit_snapshot: None,
                updated_at: chrono::Utc::now().to_rfc3339(),
                status: "ok".into(),
                message: None,
            });
        }
        Ok(ProviderSnapshot {
            provider: "workbuddy".into(),
            display_name: "WORKBUDDY".into(),
            plan: Some("Enterprise".into()),
            short_window: None,
            weekly_window: None,
            monthly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            balance_remaining: Some((limit - used).max(0.0)),
            balance_unit: Some("credits".into()),
            rate_limit_snapshot: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: "ok".into(),
            message: None,
        })
    }

    async fn limited_json(mut response: reqwest::Response) -> Result<Value, ()> {
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES)
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if bytes.len().saturating_add(chunk.len()) as u64 > MAX_RESPONSE_BYTES {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ())
    }

    fn http_failure(status: reqwest::StatusCode) -> ProviderSnapshot {
        let (state, message) = match status.as_u16() {
            401 | 403 => (
                "signed_out",
                "WorkBuddy login expired. Please sign in again.",
            ),
            429 => ("unavailable", "WorkBuddy quota service is rate limited."),
            _ => (
                "unavailable",
                "WorkBuddy quota service is temporarily unavailable.",
            ),
        };
        ProviderSnapshot::provider_failure("workbuddy", "WORKBUDDY", state, message)
    }

    async fn send_personal(
        client: &reqwest::Client,
        headers: HeaderMap,
    ) -> Result<Value, Box<ProviderSnapshot>> {
        let body = serde_json::json!({
            "PageNumber": 1,
            "PageSize": 100,
            "ProductCode": PRODUCT_CODE,
            "Status": [0, 3],
            "PackageStartTimeRangeBegin": "2024-12-01 21:25:00",
            "PackageStartTimeRangeEnd": chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
        });
        let response = client
            .post(format!("{ENDPOINT}/v2/billing/meter/get-user-resource"))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|_| {
                ProviderSnapshot::provider_failure(
                    "workbuddy",
                    "WORKBUDDY",
                    "unavailable",
                    "Network unavailable. WorkBuddy will retry automatically.",
                )
            })?;
        if !response.status().is_success() {
            return Err(Box::new(http_failure(response.status())));
        }
        limited_json(response).await.map_err(|_| {
            ProviderSnapshot::provider_failure(
                "workbuddy",
                "WORKBUDDY",
                "unavailable",
                "WorkBuddy returned an unsupported quota response.",
            )
            .into()
        })
    }

    async fn send_enterprise(
        client: &reqwest::Client,
        headers: HeaderMap,
    ) -> Result<Value, Box<ProviderSnapshot>> {
        let response = client
            .post(format!(
                "{ENDPOINT}/v2/billing/meter/get-enterprise-user-usage"
            ))
            .headers(headers)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| {
                ProviderSnapshot::provider_failure(
                    "workbuddy",
                    "WORKBUDDY",
                    "unavailable",
                    "Network unavailable. WorkBuddy will retry automatically.",
                )
            })?;
        if !response.status().is_success() {
            return Err(Box::new(http_failure(response.status())));
        }
        limited_json(response).await.map_err(|_| {
            ProviderSnapshot::provider_failure(
                "workbuddy",
                "WORKBUDDY",
                "unavailable",
                "WorkBuddy returned an unsupported quota response.",
            )
            .into()
        })
    }

    fn is_enterprise(account_type: Option<&str>) -> bool {
        account_type.is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("enterprise")
                || value.contains("ultimate")
                || value.contains("exclusive")
        })
    }

    pub async fn snapshot(client: &reqwest::Client) -> Option<ProviderSnapshot> {
        root()?;
        let auth = match load_auth() {
            Ok(auth) => auth,
            Err(message) => {
                return Some(ProviderSnapshot::provider_failure(
                    "workbuddy",
                    "WORKBUDDY",
                    "signed_out",
                    message,
                ))
            }
        };
        let headers = match headers(&auth) {
            Ok(headers) => headers,
            Err(message) => {
                return Some(ProviderSnapshot::provider_failure(
                    "workbuddy",
                    "WORKBUDDY",
                    "signed_out",
                    message,
                ))
            }
        };
        if is_enterprise(auth.account_type.as_deref()) {
            return Some(match send_enterprise(client, headers).await {
                Ok(value) => parse_enterprise(&value).unwrap_or_else(|message| {
                    ProviderSnapshot::provider_failure(
                        "workbuddy",
                        "WORKBUDDY",
                        "unavailable",
                        message,
                    )
                }),
                Err(snapshot) => *snapshot,
            });
        }
        Some(match send_personal(client, headers).await {
            Ok(value) => {
                parse_personal(&value, auth.account_type.as_deref()).unwrap_or_else(|message| {
                    ProviderSnapshot::provider_failure(
                        "workbuddy",
                        "WORKBUDDY",
                        "unavailable",
                        message,
                    )
                })
            }
            Err(snapshot) => *snapshot,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_personal_resource_accounts() {
            let value = serde_json::json!({
                "data": {"data": {"Response": {"Data": {"Accounts": [
                    {"PackageCode": "workbuddy_pro", "CycleCapacitySizePrecise": "1000", "CycleCapacityRemainPrecise": "420"},
                    {"PackageCode": "bonus", "CycleCapacitySizePrecise": 100, "CycleCapacityRemainPrecise": 80}
                ]}}}}
            });
            let snapshot = parse_personal(&value, Some("personal")).unwrap();
            assert_eq!(snapshot.balance_remaining, Some(500.0));
            assert_eq!(snapshot.plan.as_deref(), Some("Pro"));
        }

        #[test]
        fn parses_enterprise_usage() {
            let value = serde_json::json!({"data": {"data": {"limitNum": 3000, "credit": 1250}}});
            let snapshot = parse_enterprise(&value).unwrap();
            assert_eq!(snapshot.balance_remaining, Some(1750.0));
        }
    }
}

pub async fn fetch_snapshot(client: &reqwest::Client) -> Option<ProviderSnapshot> {
    #[cfg(windows)]
    {
        return windows::snapshot(client).await;
    }
    #[cfg(not(windows))]
    {
        let _ = client;
        None
    }
}

use crate::models::ProviderSnapshot;

#[cfg(windows)]
mod windows {
    use super::*;
    use aes::Aes128;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
    use serde_json::Value;
    use sha2::{Digest, Sha512};
    use std::{fs, path::PathBuf};

    const USAGE_URL: &str = "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage";
    const STORAGE_KEY: &str = "iCubeAuthInfo://icube.cloudide";
    const MAX_STORAGE_BYTES: u64 = 4 * 1024 * 1024;
    const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
    const NORMAL_HEADER: [u8; 6] = [116, 99, 5, 16, 0, 0];
    const PRIVATE_HEADER: [u8; 6] = [18, 57, 32, 32, 2, 3];
    const NORMAL_LEFT: [u8; 64] = [
        82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
        155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
        238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
        109, 139, 209, 37,
    ];
    const NORMAL_RIGHT: [u8; 64] = [
        31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
        181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176,
        200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99,
        85, 33, 12, 125,
    ];
    const PRIVATE_LEFT: [u8; 64] = [
        191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18,
        127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141,
        177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12,
        117, 4, 89, 149, 168, 209,
    ];
    const PRIVATE_RIGHT: [u8; 64] = [
        246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165,
        42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165,
        182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82,
        191, 134, 76, 170,
    ];

    fn root() -> Option<PathBuf> {
        let roaming = dirs::data_dir()?;
        ["TRAE SOLO CN", "Trae CN", "Trae"]
            .into_iter()
            .map(|name| roaming.join(name))
            .find(|root| {
                root.join("User")
                    .join("globalStorage")
                    .join("storage.json")
                    .exists()
            })
    }

    fn derive_key_iv(random_key: &[u8], private: bool) -> ([u8; 16], [u8; 16]) {
        let first = Sha512::digest(random_key);
        let (left, right) = if private {
            (&PRIVATE_LEFT, &PRIVATE_RIGHT)
        } else {
            (&NORMAL_LEFT, &NORMAL_RIGHT)
        };
        let mut seed = [0u8; 128];
        seed[..64].copy_from_slice(&first);
        for index in 0..64 {
            seed[64 + index] = left[index] ^ right[index];
        }
        let digest = Sha512::digest(seed);
        let mut key = [0u8; 16];
        let mut iv = [0u8; 16];
        key.copy_from_slice(&digest[..16]);
        iv.copy_from_slice(&digest[16..32]);
        (key, iv)
    }

    fn decrypt_storage_value(encoded: &str) -> Result<Vec<u8>, &'static str> {
        let bytes = STANDARD
            .decode(encoded.trim())
            .map_err(|_| "TRAE login data is not valid base64.")?;
        if bytes.len() <= 38 {
            return Err("TRAE login data is incomplete.");
        }
        let private = if bytes.starts_with(&NORMAL_HEADER) {
            false
        } else if bytes.starts_with(&PRIVATE_HEADER) {
            true
        } else {
            return Err("TRAE uses an unsupported credential format.");
        };
        let (key, iv) = derive_key_iv(&bytes[6..38], private);
        let decrypted = cbc::Decryptor::<Aes128>::new_from_slices(&key, &iv)
            .map_err(|_| "TRAE credential cipher is invalid.")?
            .decrypt_padded_vec_mut::<Pkcs7>(&bytes[38..])
            .map_err(|_| "TRAE credentials could not be decrypted.")?;
        if decrypted.len() < 64 {
            return Err("TRAE credential payload is incomplete.");
        }
        let payload = &decrypted[64..];
        if Sha512::digest(payload).as_slice() != &decrypted[..64] {
            return Err("TRAE credential integrity check failed.");
        }
        Ok(payload.to_vec())
    }

    fn load_auth() -> Result<Value, &'static str> {
        let path = root()
            .ok_or("TRAE is not installed for this user.")?
            .join("User")
            .join("globalStorage")
            .join("storage.json");
        let metadata = fs::metadata(&path).map_err(|_| "TRAE login data is unavailable.")?;
        if !metadata.is_file() || metadata.len() > MAX_STORAGE_BYTES {
            return Err("TRAE login data is unavailable.");
        }
        let storage: Value = serde_json::from_slice(
            &fs::read(path).map_err(|_| "TRAE login data could not be read.")?,
        )
        .map_err(|_| "TRAE login data has an unsupported format.")?;
        let encoded = storage
            .get(STORAGE_KEY)
            .and_then(Value::as_str)
            .ok_or("Sign in to TRAE to view quota.")?;
        let plain = decrypt_storage_value(encoded)?;
        serde_json::from_slice(&plain).map_err(|_| "TRAE account data has an unsupported format.")
    }

    fn auth_token(value: &Value) -> Option<&str> {
        ["/token", "/auth/token", "/accessToken", "/auth/accessToken"]
            .iter()
            .find_map(|pointer| value.pointer(pointer)?.as_str())
    }

    fn number(value: &Value, keys: &[&str]) -> Option<f64> {
        keys.iter().find_map(|key| {
            let value = value.get(*key)?;
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|number| number as f64))
                .or_else(|| value.as_str()?.parse().ok())
        })
    }

    fn active_pack(pack: &Value) -> bool {
        let Some(end_time) = pack
            .get("expire_time")
            .or_else(|| pack.pointer("/entitlement_base_info/end_time"))
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
        else {
            return true;
        };
        if end_time <= 0 {
            return true;
        }
        let seconds = if end_time > 10_000_000_000 {
            end_time / 1000
        } else {
            end_time
        };
        seconds >= chrono::Utc::now().timestamp()
    }

    fn plan_name(product_type: i64) -> (&'static str, u8) {
        match product_type {
            100 => ("Express", 7),
            6 => ("Ultra", 6),
            4 | 5 => ("Pro+", 5),
            1 => ("Pro", 4),
            8 => ("Lite", 3),
            9 => ("Solo Invite", 2),
            2 => ("Package", 1),
            3 => ("Promo", 1),
            _ => ("Free", 0),
        }
    }

    fn response_payload(value: &Value) -> &Value {
        value
            .get("data")
            .and_then(|data| {
                if data.get("user_entitlement_pack_list").is_some() {
                    Some(data)
                } else {
                    data.get("data")
                }
            })
            .unwrap_or(value)
    }

    fn parse_snapshot(value: &Value) -> Result<ProviderSnapshot, &'static str> {
        if value
            .get("code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        {
            return Err("TRAE quota request was rejected.");
        }
        let payload = response_payload(value);
        let packs = payload
            .get("user_entitlement_pack_list")
            .and_then(Value::as_array)
            .ok_or("TRAE response is missing entitlement quota data.")?;
        let mut fast_total = 0.0;
        let mut fast_used = 0.0;
        let mut basic_total = 0.0;
        let mut basic_used = 0.0;
        let mut has_credit_quota = false;
        let mut current_credit_remaining = 0.0;
        let mut has_current_credit_quota = false;
        let mut unlimited_current_credits = false;
        let mut best_plan = ("Free", 0u8);
        let mut active_packs = 0usize;
        for pack in packs.iter().filter(|pack| active_pack(pack)) {
            active_packs += 1;
            let base = pack.get("entitlement_base_info").unwrap_or(pack);
            let quota = base.get("quota").unwrap_or(base);
            let usage = pack.get("usage").unwrap_or(pack);
            let product_type = number(base, &["product_type"]).unwrap_or(0.0).round() as i64;
            let plan = plan_name(product_type);
            if plan.1 > best_plan.1 {
                best_plan = plan;
            }
            match number(quota, &["credits_limit"]) {
                Some(limit) if (limit + 1.0).abs() < f64::EPSILON => {
                    has_current_credit_quota = true;
                    unlimited_current_credits = true;
                }
                Some(limit) if limit > 0.0 => {
                    has_current_credit_quota = true;
                    let used = number(usage, &["credits_amount"]).unwrap_or(0.0).max(0.0);
                    current_credit_remaining += (limit - used).max(0.0);
                }
                _ => {}
            }
            let fast_limit = number(quota, &["premium_model_fast_request_limit"]).unwrap_or(0.0);
            if fast_limit > 0.0 {
                fast_total += fast_limit;
                fast_used += number(
                    usage,
                    &[
                        "premium_model_fast_amount",
                        "premium_model_fast_request_usage",
                    ],
                )
                .unwrap_or(0.0)
                .max(0.0);
            }
            let no_bonus = quota
                .get("no_bonus_quota")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            for (limit_key, used_key, enabled) in [
                ("basic_usage_limit", "basic_usage_amount", true),
                ("bonus_usage_limit", "bonus_usage_amount", !no_bonus),
            ] {
                let limit = if enabled {
                    number(quota, &[limit_key])
                } else {
                    None
                };
                if let Some(limit) = limit.filter(|limit| *limit >= 0.0) {
                    has_credit_quota = true;
                    basic_total += limit;
                    basic_used += number(usage, &[used_key]).unwrap_or(0.0).max(0.0);
                }
            }
        }
        let (remaining, unit) = if unlimited_current_credits {
            (0.0, "unlimited")
        } else if has_current_credit_quota {
            (current_credit_remaining, "credits")
        } else if has_credit_quota {
            ((basic_total - basic_used).max(0.0), "credits")
        } else if fast_total > 0.0 {
            ((fast_total - fast_used).max(0.0), "requests")
        } else if active_packs > 0 && best_plan.1 == 0 {
            (0.0, "unlimited")
        } else {
            return Err("TRAE has no active measurable quota package.");
        };
        let updated_at = payload
            .get("server_time_ms")
            .and_then(Value::as_i64)
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|time| time.to_rfc3339())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        Ok(ProviderSnapshot {
            provider: "trae".into(),
            display_name: "TRAE".into(),
            plan: Some(best_plan.0.into()),
            short_window: None,
            weekly_window: None,
            monthly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            balance_remaining: Some(remaining),
            balance_unit: Some(unit.into()),
            rate_limit_snapshot: None,
            updated_at,
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
            401 | 403 => ("signed_out", "TRAE login expired. Please sign in again."),
            429 => ("unavailable", "TRAE quota service is rate limited."),
            _ => (
                "unavailable",
                "TRAE quota service is temporarily unavailable.",
            ),
        };
        ProviderSnapshot::provider_failure("trae", "TRAE", state, message)
    }

    pub async fn snapshot(client: &reqwest::Client) -> Option<ProviderSnapshot> {
        root()?;
        let auth = match load_auth() {
            Ok(value) => value,
            Err(message) => {
                return Some(ProviderSnapshot::provider_failure(
                    "trae",
                    "TRAE",
                    "signed_out",
                    message,
                ))
            }
        };
        let token = match auth_token(&auth) {
            Some(token) => token,
            None => {
                return Some(ProviderSnapshot::provider_failure(
                    "trae",
                    "TRAE",
                    "signed_out",
                    "TRAE login has expired.",
                ))
            }
        };
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut authorization = match HeaderValue::from_str(&format!("Cloud-IDE-JWT {token}")) {
            Ok(value) => value,
            Err(_) => {
                return Some(ProviderSnapshot::provider_failure(
                    "trae",
                    "TRAE",
                    "signed_out",
                    "TRAE login data is invalid.",
                ))
            }
        };
        authorization.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
        let response = match client
            .post(USAGE_URL)
            .headers(headers)
            .json(&serde_json::json!({"require_usage": true}))
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => {
                return Some(ProviderSnapshot::provider_failure(
                    "trae",
                    "TRAE",
                    "unavailable",
                    "Network unavailable. TRAE will retry automatically.",
                ))
            }
        };
        if !response.status().is_success() {
            return Some(http_failure(response.status()));
        }
        let value = match limited_json(response).await {
            Ok(value) => value,
            Err(_) => {
                return Some(ProviderSnapshot::provider_failure(
                    "trae",
                    "TRAE",
                    "unavailable",
                    "TRAE returned an unsupported quota response.",
                ))
            }
        };
        Some(parse_snapshot(&value).unwrap_or_else(|message| {
            ProviderSnapshot::provider_failure("trae", "TRAE", "unavailable", message)
        }))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use cbc::cipher::BlockEncryptMut;

        #[test]
        fn decrypts_current_trae_storage_format() {
            let random_key = [7u8; 32];
            let payload = br#"{"userId":"test","token":"safe-test-token","account":{}}"#;
            let (key, iv) = derive_key_iv(&random_key, false);
            let mut plain = Sha512::digest(payload).to_vec();
            plain.extend_from_slice(payload);
            let encrypted = cbc::Encryptor::<Aes128>::new_from_slices(&key, &iv)
                .unwrap()
                .encrypt_padded_vec_mut::<Pkcs7>(&plain);
            let mut blob = NORMAL_HEADER.to_vec();
            blob.extend_from_slice(&random_key);
            blob.extend_from_slice(&encrypted);
            assert_eq!(
                decrypt_storage_value(&STANDARD.encode(blob)).unwrap(),
                payload
            );
        }

        #[test]
        fn parses_entitlement_usage() {
            let value = serde_json::json!({
                "code": 0,
                "server_time_ms": 1_784_207_732_000i64,
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 4,
                        "quota": {
                            "premium_model_fast_request_limit": 1000
                        }
                    },
                    "usage": {"premium_model_fast_amount": 275}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Pro+"));
            assert_eq!(snapshot.balance_remaining, Some(725.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("requests"));
        }

        #[test]
        fn prefers_credit_balance_over_migrated_fast_requests() {
            let value = serde_json::json!({
                "code": 0,
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 4,
                        "quota": {
                            "premium_model_fast_request_limit": 1000,
                            "basic_usage_limit": 500,
                            "bonus_usage_limit": 200
                        }
                    },
                    "usage": {
                        "premium_model_fast_amount": 275,
                        "basic_usage_amount": 150,
                        "bonus_usage_amount": 25
                    }
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Pro+"));
            assert_eq!(snapshot.balance_remaining, Some(525.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("credits"));
        }

        #[test]
        fn treats_zero_credit_allowance_as_exhausted() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 0,
                        "quota": {
                            "premium_model_fast_request_limit": 100,
                            "basic_usage_limit": 0
                        }
                    },
                    "usage": {
                        "premium_model_fast_amount": 20,
                        "basic_usage_amount": 0
                    }
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Free"));
            assert_eq!(snapshot.balance_remaining, Some(0.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("credits"));
        }

        #[test]
        fn ignores_bonus_when_plan_disables_it() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 1,
                        "quota": {
                            "basic_usage_limit": 500,
                            "bonus_usage_limit": 100,
                            "no_bonus_quota": true
                        }
                    },
                    "usage": {
                        "basic_usage_amount": 150,
                        "bonus_usage_amount": 20
                    }
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.balance_remaining, Some(350.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("credits"));
        }

        #[test]
        fn ignores_expired_credit_packages() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "expire_time": 1,
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"basic_usage_limit": 1000}
                    },
                    "usage": {"basic_usage_amount": 0}
                }, {
                    "entitlement_base_info": {
                        "product_type": 1,
                        "quota": {"basic_usage_limit": 500}
                    },
                    "usage": {"basic_usage_amount": 150}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Pro"));
            assert_eq!(snapshot.balance_remaining, Some(350.0));
        }

        #[test]
        fn treats_legacy_free_plan_without_a_meter_as_unlimited() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 0,
                        "quota": {"enable_solo_builder": true}
                    },
                    "usage": {}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Free"));
            assert_eq!(snapshot.balance_remaining, Some(0.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("unlimited"));
        }

        #[test]
        fn counts_current_credits_across_entitlement_packs() {
            let value = serde_json::json!({
                "code": 0,
                "is_credits_billing": true,
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"credits_limit": 2000}
                    },
                    "usage": {}
                }, {
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"credits_limit": 500}
                    },
                    "usage": {"credits_amount": 217.93}
                }, {
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"credits_limit": 200}
                    },
                    "usage": {}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.plan.as_deref(), Some("Package"));
            assert!(
                (snapshot.balance_remaining.unwrap() - 2482.07).abs() < f64::EPSILON,
                "remaining credits should match TRAE's per-pack aggregation"
            );
            assert_eq!(snapshot.balance_unit.as_deref(), Some("credits"));
        }

        #[test]
        fn does_not_let_an_overused_credit_pack_consume_another_pack() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"credits_limit": 100}
                    },
                    "usage": {"credits_amount": 150}
                }, {
                    "entitlement_base_info": {
                        "product_type": 2,
                        "quota": {"credits_limit": 100}
                    },
                    "usage": {}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.balance_remaining, Some(100.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("credits"));
        }

        #[test]
        fn treats_negative_one_credit_limit_as_unlimited() {
            let value = serde_json::json!({
                "user_entitlement_pack_list": [{
                    "entitlement_base_info": {
                        "product_type": 1,
                        "quota": {"credits_limit": -1}
                    },
                    "usage": {"credits_amount": 250}
                }]
            });
            let snapshot = parse_snapshot(&value).unwrap();
            assert_eq!(snapshot.balance_remaining, Some(0.0));
            assert_eq!(snapshot.balance_unit.as_deref(), Some("unlimited"));
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

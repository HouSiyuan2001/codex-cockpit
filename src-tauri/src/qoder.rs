use crate::models::ProviderSnapshot;

#[cfg(windows)]
mod windows {
    use super::*;
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::{engine::general_purpose::STANDARD, Engine};
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

    #[derive(Deserialize)]
    struct SecretBlob {
        data: Vec<u8>,
    }

    fn roots() -> Vec<PathBuf> {
        let Some(roaming) = dirs::data_dir() else {
            return Vec::new();
        };
        ["QoderCN", "Qoder"]
            .into_iter()
            .map(|name| roaming.join(name))
            .collect()
    }

    fn decrypt_dpapi(input: &[u8]) -> Result<Vec<u8>, String> {
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
            return Err("Qoder credentials could not be unlocked for this Windows user.".into());
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe { LocalFree(output.pbData.cast()) };
        Ok(bytes)
    }

    fn encryption_key(root: &Path) -> Result<Vec<u8>, String> {
        let state: Value = serde_json::from_slice(
            &fs::read(root.join("Local State")).map_err(|_| "Qoder Local State is unavailable.")?,
        )
        .map_err(|_| "Qoder Local State has an unsupported format.")?;
        let encoded = state
            .pointer("/os_crypt/encrypted_key")
            .and_then(Value::as_str)
            .ok_or("Qoder encryption key is missing.")?;
        let encrypted = STANDARD
            .decode(encoded)
            .map_err(|_| "Qoder encryption key is invalid.")?;
        let payload = encrypted.strip_prefix(b"DPAPI").unwrap_or(&encrypted);
        decrypt_dpapi(payload)
    }

    fn read_secret(root: &Path, key: &[u8], name: &str) -> Result<Value, String> {
        let db = root.join("User").join("globalStorage").join("state.vscdb");
        let connection =
            Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "Qoder account cache is unavailable.")?;
        let raw: String = connection
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?1",
                [name],
                |row| row.get(0),
            )
            .map_err(|_| "Sign in to Qoder to view quota.")?;
        let secret: SecretBlob = serde_json::from_str(&raw)
            .map_err(|_| "Qoder account cache has an unsupported format.")?;
        if secret.data.len() < 31 || &secret.data[..3] != b"v10" {
            return Err("Qoder uses an unsupported credential format.".into());
        }
        let cipher =
            Aes256Gcm::new_from_slice(key).map_err(|_| "Qoder encryption key is invalid.")?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&secret.data[3..15]), &secret.data[15..])
            .map_err(|_| "Qoder credentials could not be decrypted.")?;
        serde_json::from_slice(&plain)
            .map_err(|_| "Qoder account data has an unsupported format.".into())
    }

    pub fn snapshot() -> Option<ProviderSnapshot> {
        let root = roots()
            .into_iter()
            .find(|path| path.join("Local State").exists())?;
        Some(
            match (|| {
                let key = encryption_key(&root)?;
                let user = read_secret(&root, &key, "secret://aicoding.auth.userInfo")?;
                let plan = read_secret(&root, &key, "secret://aicoding.auth.userPlan").ok();
                let quota = user
                    .get("quota")
                    .and_then(Value::as_f64)
                    .ok_or("Qoder quota is missing from the local account cache.")?;
                let exceeded = user
                    .get("isQuotaExceeded")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok::<_, String>(ProviderSnapshot {
                    provider: "qoder".into(),
                    display_name: "QODER".into(),
                    plan: plan
                        .as_ref()
                        .and_then(|value| value.get("plan_tier_name"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    short_window: None,
                    weekly_window: None,
                    monthly_window: None,
                    reset_credits: None,
                    reset_credit_expires_at: Vec::new(),
                    balance_remaining: Some(if exceeded { 0.0 } else { quota }),
                    balance_unit: Some("credits".into()),
                    rate_limit_snapshot: None,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    status: "ok".into(),
                    message: None,
                })
            })() {
                Ok(value) => value,
                Err(message) => {
                    ProviderSnapshot::provider_failure("qoder", "QODER", "signed_out", &message)
                }
            },
        )
    }
}

pub fn fetch_snapshot() -> Option<ProviderSnapshot> {
    #[cfg(windows)]
    {
        windows::snapshot()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

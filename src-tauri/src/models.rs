use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
    pub window_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    pub source: String,
    pub used_percent: f64,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider: String,
    pub display_name: String,
    pub plan: Option<String>,
    pub short_window: Option<UsageWindow>,
    pub weekly_window: Option<UsageWindow>,
    pub monthly_window: Option<UsageWindow>,
    pub reset_credits: Option<u64>,
    pub reset_credit_expires_at: Vec<String>,
    pub balance_remaining: Option<f64>,
    pub balance_unit: Option<String>,
    pub rate_limit_snapshot: Option<RateLimitSnapshot>,
    pub updated_at: String,
    pub status: String,
    pub message: Option<String>,
}

impl ProviderSnapshot {
    pub fn failure(status: &str, message: &str) -> Self {
        Self::provider_failure("codex", "CODEX", status, message)
    }

    pub fn provider_failure(
        provider: &str,
        display_name: &str,
        status: &str,
        message: &str,
    ) -> Self {
        Self {
            provider: provider.into(),
            display_name: display_name.into(),
            plan: None,
            short_window: None,
            weekly_window: None,
            monthly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            balance_remaining: None,
            balance_unit: None,
            rate_limit_snapshot: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: status.into(),
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPreferences {
    #[serde(default = "default_true")]
    pub codex_focus_mode: bool,
    #[serde(default = "default_daily_budget_percent")]
    pub daily_budget_percent: f64,
    #[serde(default)]
    pub daily_budget_local_date: Option<String>,
    #[serde(default)]
    pub reset_risk_override_percent: Option<f64>,
    #[serde(default)]
    pub reset_risk_manual_enabled: bool,
    pub locked: bool,
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
    #[serde(default)]
    pub stay_expanded: bool,
    pub pinned_provider: Option<String>,
    #[serde(default = "default_provider_order")]
    pub provider_order: Vec<String>,
    pub auto_rotate_seconds: u64,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub skipped_update_version: Option<String>,
    #[serde(default)]
    pub hidden_providers: Vec<String>,
    #[serde(default)]
    pub collapsed_providers: Vec<String>,
    #[serde(default = "default_layout_mode")]
    pub layout_mode: String,
    #[serde(default = "default_compact_layout")]
    pub compact_layout: String,
    #[serde(default = "default_expanded_layout")]
    pub expanded_layout: String,
    #[serde(default = "default_color_theme")]
    pub color_theme: String,
    #[serde(default, skip_serializing)]
    pub visual_style: Option<String>,
    #[serde(default = "default_appearance_mode")]
    pub appearance_mode: String,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_scale")]
    pub font_scale: f64,
    #[serde(default)]
    pub person_ring_colors: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub risk_first: bool,
    #[serde(default = "default_true")]
    pub show_history_sparklines: bool,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_alert_threshold")]
    pub alert_threshold: u8,
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub notify_on_reset: bool,
    #[serde(default = "default_true")]
    pub notify_on_recovery: bool,
    #[serde(default = "default_quiet_start")]
    pub quiet_hours_start: u8,
    #[serde(default = "default_quiet_end")]
    pub quiet_hours_end: u8,
    #[serde(default = "default_notification_cooldown")]
    pub notification_cooldown_minutes: u16,
    #[serde(default = "default_update_channel")]
    pub update_channel: String,
    #[serde(default = "default_true")]
    pub automatic_updates: bool,
}

fn default_always_on_top() -> bool {
    true
}
fn default_language() -> String {
    "zh-CN".into()
}
fn default_provider_order() -> Vec<String> {
    [
        "codex",
        "qoder",
        "trae",
        "workbuddy",
        "volcengine",
        "antigravity",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}
fn default_layout_mode() -> String {
    "standard".into()
}
fn default_compact_layout() -> String {
    "float".into()
}
fn default_expanded_layout() -> String {
    "dashboard".into()
}
fn default_color_theme() -> String {
    "aurora".into()
}
fn default_appearance_mode() -> String {
    "light".into()
}
fn default_font_family() -> String {
    "smiley".into()
}
fn default_font_scale() -> f64 {
    1.15
}
fn default_accent_color() -> String {
    "#397ae0".into()
}
fn default_alert_threshold() -> u8 {
    15
}
fn default_daily_budget_percent() -> f64 {
    14.3
}
fn default_true() -> bool {
    true
}
fn default_quiet_start() -> u8 {
    22
}
fn default_quiet_end() -> u8 {
    8
}
fn default_notification_cooldown() -> u16 {
    120
}
fn default_update_channel() -> String {
    "stable".into()
}

impl Default for WidgetPreferences {
    fn default() -> Self {
        Self {
            codex_focus_mode: true,
            daily_budget_percent: default_daily_budget_percent(),
            daily_budget_local_date: None,
            reset_risk_override_percent: None,
            reset_risk_manual_enabled: false,
            locked: false,
            always_on_top: true,
            stay_expanded: true,
            pinned_provider: Some("codex".into()),
            provider_order: default_provider_order(),
            auto_rotate_seconds: 12,
            language: default_language(),
            skipped_update_version: None,
            hidden_providers: vec![
                "qoder".into(),
                "trae".into(),
                "workbuddy".into(),
                "volcengine".into(),
                "antigravity".into(),
            ],
            collapsed_providers: Vec::new(),
            layout_mode: default_layout_mode(),
            compact_layout: default_compact_layout(),
            expanded_layout: default_expanded_layout(),
            color_theme: default_color_theme(),
            visual_style: None,
            appearance_mode: default_appearance_mode(),
            font_family: default_font_family(),
            font_scale: default_font_scale(),
            person_ring_colors: Default::default(),
            risk_first: false,
            show_history_sparklines: true,
            accent_color: default_accent_color(),
            alert_threshold: default_alert_threshold(),
            notifications_enabled: true,
            notify_on_reset: true,
            notify_on_recovery: true,
            quiet_hours_start: default_quiet_start(),
            quiet_hours_end: default_quiet_end(),
            notification_cooldown_minutes: default_notification_cooldown(),
            update_channel: default_update_channel(),
            automatic_updates: false,
        }
    }
}

impl WidgetPreferences {
    pub fn normalized(mut self) -> Self {
        self.auto_rotate_seconds = self.auto_rotate_seconds.clamp(5, 300);
        if !matches!(
            self.pinned_provider.as_deref(),
            Some("codex" | "qoder" | "trae" | "workbuddy" | "volcengine" | "antigravity")
        ) {
            self.pinned_provider = None;
        }
        let mut provider_order = Vec::new();
        for provider in self.provider_order {
            if matches!(
                provider.as_str(),
                "codex" | "qoder" | "trae" | "workbuddy" | "volcengine" | "antigravity"
            ) && !provider_order.contains(&provider)
            {
                provider_order.push(provider);
            }
        }
        for provider in default_provider_order() {
            if !provider_order.contains(&provider) {
                provider_order.push(provider);
            }
        }
        self.provider_order = provider_order;
        if self.language != "en" && self.language != "zh-CN" {
            self.language = default_language();
        }
        self.skipped_update_version = self.skipped_update_version.and_then(|value| {
            let value = value.trim();
            (!value.is_empty() && value.len() <= 64).then(|| value.to_string())
        });
        let normalize_providers = |values: Vec<String>| {
            let mut normalized = Vec::new();
            for provider in values {
                if matches!(
                    provider.as_str(),
                    "codex" | "qoder" | "trae" | "workbuddy" | "volcengine" | "antigravity"
                ) && !normalized.contains(&provider)
                {
                    normalized.push(provider);
                }
            }
            normalized
        };
        self.hidden_providers = normalize_providers(self.hidden_providers);
        self.collapsed_providers = normalize_providers(self.collapsed_providers);
        if self.hidden_providers.len() >= default_provider_order().len() {
            self.hidden_providers.clear();
        }
        if !matches!(
            self.layout_mode.as_str(),
            "compact" | "standard" | "detailed"
        ) {
            self.layout_mode = default_layout_mode();
        }
        if let Some(legacy_style) = self.visual_style.take() {
            self.compact_layout = if legacy_style == "island" {
                "bar".into()
            } else {
                default_compact_layout()
            };
            self.expanded_layout = if legacy_style == "island" {
                "provider-bar".into()
            } else {
                default_expanded_layout()
            };
            self.color_theme = if matches!(legacy_style.as_str(), "graphite" | "paper") {
                legacy_style
            } else {
                default_color_theme()
            };
        }
        if !matches!(self.compact_layout.as_str(), "float" | "ring" | "bar") {
            self.compact_layout = default_compact_layout();
        }
        if !matches!(
            self.expanded_layout.as_str(),
            "dashboard" | "provider-bar" | "stacked"
        ) {
            self.expanded_layout = default_expanded_layout();
        }
        if !matches!(self.color_theme.as_str(), "aurora" | "graphite" | "paper") {
            self.color_theme = default_color_theme();
        }
        if !matches!(self.appearance_mode.as_str(), "system" | "light" | "dark") {
            self.appearance_mode = default_appearance_mode();
        }
        if !matches!(self.font_family.as_str(), "codex" | "yahei" | "smiley") {
            self.font_family = default_font_family();
        }
        if !self.font_scale.is_finite() {
            self.font_scale = default_font_scale();
        }
        self.font_scale = (self.font_scale.clamp(0.85, 1.5) * 20.0).round() / 20.0;
        if !is_safe_hex_color(&self.accent_color) {
            self.accent_color = default_accent_color();
        }
        self.person_ring_colors
            .retain(|id, color| !id.is_empty() && id.len() <= 128 && is_safe_hex_color(color));
        if !self.daily_budget_percent.is_finite() {
            self.daily_budget_percent = default_daily_budget_percent();
        }
        self.daily_budget_percent =
            (self.daily_budget_percent.clamp(1.0, 100.0) * 10.0).round() / 10.0;
        self.reset_risk_override_percent = self.reset_risk_override_percent.and_then(|value| {
            value
                .is_finite()
                .then(|| (value.clamp(0.0, 100.0) * 10.0).round() / 10.0)
        });
        self.alert_threshold = self.alert_threshold.clamp(1, 99);
        self.quiet_hours_start = self.quiet_hours_start.min(23);
        self.quiet_hours_end = self.quiet_hours_end.min(23);
        self.notification_cooldown_minutes = self.notification_cooldown_minutes.clamp(5, 1440);
        if !matches!(self.update_channel.as_str(), "stable" | "beta") {
            self.update_channel = default_update_channel();
        }
        self
    }
}

fn is_safe_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::WidgetPreferences;

    #[test]
    fn font_family_defaults_for_existing_preferences_without_changing_font_scale() {
        let preferences: WidgetPreferences = serde_json::from_str(
            r#"{"locked":false,"pinnedProvider":null,"autoRotateSeconds":12,"fontScale":1.3}"#,
        )
        .expect("legacy preferences should remain readable");

        assert_eq!(preferences.font_family, "smiley");
        assert_eq!(preferences.font_scale, 1.3);
        let normalized = preferences.normalized();
        assert_eq!(normalized.font_family, "smiley");
        assert_eq!(normalized.font_scale, 1.3);
    }

    #[test]
    fn font_family_presets_roundtrip_as_camel_case() {
        for font_family in ["codex", "yahei", "smiley"] {
            let preferences = WidgetPreferences {
                font_family: font_family.into(),
                font_scale: 1.25,
                ..Default::default()
            };
            let json = serde_json::to_value(preferences.normalized())
                .expect("preferences should serialize");
            assert_eq!(json["fontFamily"], font_family);
            assert!(json.get("font_family").is_none());
            let restored: WidgetPreferences =
                serde_json::from_value(json).expect("font preferences should remain readable");
            assert_eq!(restored.font_family, font_family);
            assert_eq!(restored.font_scale, 1.25);
        }
    }

    #[test]
    fn unknown_font_family_falls_back_to_smiley() {
        for font_family in ["", "unknown", "Codex", "url(remote-font)"] {
            let preferences = WidgetPreferences {
                font_family: font_family.into(),
                ..Default::default()
            };
            assert_eq!(preferences.normalized().font_family, "smiley");
        }
    }

    #[test]
    fn skipped_update_version_is_optional_for_existing_preferences() {
        let preferences: WidgetPreferences = serde_json::from_str(
            r#"{"locked":false,"pinnedProvider":null,"autoRotateSeconds":12,"resetRiskAdjustmentPercent":7}"#,
        )
        .expect("legacy preferences should remain readable");

        assert_eq!(preferences.skipped_update_version, None);
        assert_eq!(preferences.reset_risk_override_percent, None);
    }

    #[test]
    fn skipped_update_version_is_trimmed_and_bounded() {
        let preferences = WidgetPreferences {
            skipped_update_version: Some(" 0.2.0 ".into()),
            ..Default::default()
        };
        assert_eq!(
            preferences.normalized().skipped_update_version.as_deref(),
            Some("0.2.0")
        );

        let preferences = WidgetPreferences {
            skipped_update_version: Some("x".repeat(65)),
            ..Default::default()
        };
        assert_eq!(preferences.normalized().skipped_update_version, None);
    }

    #[test]
    fn provider_order_is_deduplicated_and_completed() {
        let preferences = WidgetPreferences {
            provider_order: vec![
                "qoder".into(),
                "unknown".into(),
                "qoder".into(),
                "codex".into(),
            ],
            ..Default::default()
        };
        assert_eq!(
            preferences.normalized().provider_order,
            vec![
                "qoder",
                "codex",
                "trae",
                "workbuddy",
                "volcengine",
                "antigravity",
            ]
        );
    }

    #[test]
    fn person_ring_colors_roundtrip_and_reject_invalid_values() {
        let mut preferences = WidgetPreferences::default();
        preferences
            .person_ring_colors
            .insert("alex".into(), "#123456".into());
        preferences
            .person_ring_colors
            .insert("bad".into(), "red;url(x)".into());
        let json = serde_json::to_string(&preferences.normalized()).unwrap();
        let restored: WidgetPreferences = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.person_ring_colors.get("alex").unwrap(), "#123456");
        assert!(!restored.person_ring_colors.contains_key("bad"));
    }

    #[test]
    fn quality_of_life_preferences_are_safely_normalized() {
        let preferences = WidgetPreferences {
            hidden_providers: vec![
                "codex".into(),
                "qoder".into(),
                "trae".into(),
                "workbuddy".into(),
                "volcengine".into(),
                "antigravity".into(),
            ],
            accent_color: "red; background: url(x)".into(),
            alert_threshold: 0,
            daily_budget_percent: 200.04,
            daily_budget_local_date: Some("2026-08-16".into()),
            reset_risk_override_percent: Some(120.04),
            font_scale: 2.0,
            ..Default::default()
        };
        let normalized = preferences.normalized();
        assert!(normalized.hidden_providers.is_empty());
        assert_eq!(normalized.accent_color, "#397ae0");
        assert_eq!(normalized.alert_threshold, 1);
        assert_eq!(normalized.daily_budget_percent, 100.0);
        assert_eq!(
            normalized.daily_budget_local_date.as_deref(),
            Some("2026-08-16")
        );
        assert_eq!(normalized.reset_risk_override_percent, Some(100.0));
        assert_eq!(normalized.font_scale, 1.5);
    }

    #[test]
    fn layout_and_color_are_backward_compatible_and_bounded() {
        let legacy: WidgetPreferences = serde_json::from_str(
            r#"{"locked":false,"pinnedProvider":null,"autoRotateSeconds":12,"visualStyle":"island"}"#,
        )
        .expect("legacy preferences should remain readable");
        let legacy = legacy.normalized();
        assert_eq!(legacy.compact_layout, "bar");
        assert_eq!(legacy.expanded_layout, "provider-bar");
        assert_eq!(legacy.color_theme, "aurora");
        assert_eq!(legacy.appearance_mode, "light");
        assert!(legacy.show_history_sparklines);
        let serialized = serde_json::to_value(&legacy).expect("preferences should serialize");
        assert_eq!(serialized["compactLayout"], "bar");
        assert_eq!(serialized["expandedLayout"], "provider-bar");
        assert_eq!(serialized["colorTheme"], "aurora");
        assert!(serialized.get("visualStyle").is_none());

        let preferences = WidgetPreferences {
            compact_layout: "stack".into(),
            expanded_layout: "stack".into(),
            color_theme: "neon".into(),
            ..Default::default()
        };
        let normalized = preferences.normalized();
        assert_eq!(normalized.compact_layout, "float");
        assert_eq!(normalized.expanded_layout, "dashboard");
        assert_eq!(normalized.color_theme, "aurora");

        let preferences = WidgetPreferences {
            compact_layout: "bar".into(),
            expanded_layout: "provider-bar".into(),
            color_theme: "paper".into(),
            appearance_mode: "dark".into(),
            ..Default::default()
        };
        let normalized = preferences.normalized();
        assert_eq!(normalized.compact_layout, "bar");
        assert_eq!(normalized.expanded_layout, "provider-bar");
        assert_eq!(normalized.color_theme, "paper");
        assert_eq!(normalized.appearance_mode, "dark");

        let preferences = WidgetPreferences {
            compact_layout: "ring".into(),
            expanded_layout: "stacked".into(),
            ..Default::default()
        };
        let normalized = preferences.normalized();
        assert_eq!(normalized.compact_layout, "ring");
        assert_eq!(normalized.expanded_layout, "stacked");

        let preferences = WidgetPreferences {
            appearance_mode: "sepia".into(),
            ..Default::default()
        };
        assert_eq!(preferences.normalized().appearance_mode, "light");
    }
}

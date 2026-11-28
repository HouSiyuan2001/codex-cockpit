use serde::Deserialize;
use tauri::AppHandle;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Quota {
    weekly: Option<f64>,
    five_hour: Option<f64>,
    #[serde(default)]
    show_weekly: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Quotas {
    codex: Option<Quota>,
    claude: Option<Quota>,
    gemini: Option<Quota>,
    gemini_shared: Option<Quota>,
}

fn percentage(value: Option<f64>) -> Option<f64> {
    value
        .filter(|percent| percent.is_finite())
        .map(|percent| percent.clamp(0.0, 100.0))
}

fn label(value: Option<f64>) -> String {
    percentage(value).map_or_else(|| "—".into(), |percent| format!("{percent:.0}%"))
}

impl Quota {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn displayed_percent(self) -> Option<f64> {
        if self.show_weekly {
            self.weekly
        } else {
            self.five_hour
        }
    }
}

impl Quotas {
    fn entries(&self) -> impl Iterator<Item = (&'static str, Quota)> {
        [
            ("Codex", self.codex),
            ("Claude", self.claude),
            ("Gemini", self.gemini),
            ("Gemini · Claude / GPT", self.gemini_shared),
        ]
        .into_iter()
        .filter_map(|(name, quota)| quota.map(|quota| (name, quota)))
    }

    fn tooltip(&self, english: bool) -> String {
        let (week, short) = if english {
            ("Week", "5h left")
        } else {
            ("本周剩余", "5h 剩余")
        };
        self.entries()
            .map(|(name, quota)| {
                if quota.show_weekly && quota.weekly.is_some() {
                    return format!("{name} · {week} {}", label(quota.weekly));
                }
                format!(
                    "{name} · {week} {} · {short} {}",
                    label(quota.weekly),
                    label(quota.five_hour)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[tauri::command]
pub(crate) async fn set_menu_bar_quotas(app: AppHandle, quotas: Quotas, english: bool) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(quotas.tooltip(english)));
        #[cfg(target_os = "macos")]
        let _ = tray.with_inner_tray_icon(move |native| {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{
                NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
            };
            use objc2_foundation::NSArray;
            let Some(main_thread) = MainThreadMarker::new() else {
                return;
            };
            if let Some(button) = native
                .ns_status_item()
                .and_then(|item| item.button(main_thread))
            {
                let aqua = unsafe { NSAppearanceNameAqua };
                let dark_aqua = unsafe { NSAppearanceNameDarkAqua };
                let appearances = NSArray::from_slice(&[aqua, dark_aqua]);
                let dark = button
                    .effectiveAppearance()
                    .bestMatchFromAppearancesWithNames(&appearances)
                    .as_deref()
                    == Some(dark_aqua);
                button.setImage(None);
                button.setAttributedTitle(&macos_quota_title(&quotas, dark));
            }
        });
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            let weekly = quotas
                .entries()
                .next()
                .and_then(|(_, quota)| percentage(quota.weekly));
            let _ = tray.set_icon(Some(crate::quota_tray_ring(weekly)));
        }
        #[cfg(target_os = "linux")]
        let _ = tray.set_title(Some(
            quotas
                .entries()
                .map(|(_, quota)| label(quota.displayed_percent()))
                .collect::<Vec<_>>()
                .join(" · "),
        ));
    }
}

#[cfg(target_os = "macos")]
fn macos_quota_title(
    quotas: &Quotas,
    dark: bool,
) -> objc2::rc::Retained<objc2_foundation::NSMutableAttributedString> {
    use objc2::{runtime::AnyObject, AnyThread};
    use objc2_app_kit::{
        NSAttributedStringAttachmentConveniences, NSForegroundColorAttributeName, NSTextAttachment,
    };
    use objc2_foundation::{
        NSAttributedString, NSDictionary, NSMutableAttributedString, NSPoint, NSRect, NSSize,
        NSString,
    };

    let title = NSMutableAttributedString::new();
    let pools = [
        (
            quotas.codex,
            (0x56, 0xa6, 0xe9),
            (0x25, 0x5b, 0x8c),
            (0x97, 0xce, 0xff),
        ),
        (
            quotas.claude,
            (0xf0, 0x89, 0x48),
            (0x96, 0x3b, 0x15),
            (0xff, 0xb2, 0x83),
        ),
        (
            quotas.gemini,
            (0x51, 0xbf, 0xb3),
            (0x1d, 0x6b, 0x61),
            (0x8d, 0xe4, 0xd7),
        ),
        (
            quotas.gemini_shared,
            (0xe1, 0xb1, 0x52),
            (0x79, 0x52, 0x0f),
            (0xff, 0xd9, 0x89),
        ),
    ];
    for (index, (quota, ring_color, light_text, dark_text)) in pools
        .into_iter()
        .filter_map(|(quota, ring_color, light_text, dark_text)| {
            quota.map(|quota| (quota, ring_color, light_text, dark_text))
        })
        .enumerate()
    {
        if index > 0 {
            title.appendAttributedString(&NSAttributedString::initWithString(
                NSAttributedString::alloc(),
                &NSString::from_str("  "),
            ));
        }
        let ring = NSTextAttachment::new();
        ring.setImage(Some(&macos_quota_ring(quota.weekly, ring_color)));
        ring.setBounds(NSRect::new(
            NSPoint::new(0.0, -3.0),
            NSSize::new(15.0, 15.0),
        ));
        title.appendAttributedString(&NSAttributedString::attributedStringWithAttachment(&ring));
        let short = NSString::from_str(&format!(" {}", label(quota.displayed_percent())));
        let text_color = macos_color(if dark { dark_text } else { light_text }, 1.0);
        let attributes = NSDictionary::from_slices(
            &[unsafe { NSForegroundColorAttributeName }],
            &[text_color.as_ref() as &AnyObject],
        );
        let text = unsafe {
            NSAttributedString::initWithString_attributes(
                NSAttributedString::alloc(),
                &short,
                Some(&attributes),
            )
        };
        title.appendAttributedString(&text);
    }
    title
}

#[cfg(target_os = "macos")]
fn macos_quota_ring(
    weekly: Option<f64>,
    color: (u8, u8, u8),
) -> objc2::rc::Retained<objc2_app_kit::NSImage> {
    use objc2_app_kit::{NSBezierPath, NSImage};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    const SIZE: f64 = 15.0;
    const RADIUS: f64 = 6.3;
    let draw = block2::RcBlock::new(move |_: NSRect| {
        let center = NSPoint::new(SIZE / 2.0, SIZE / 2.0);
        let ring = NSBezierPath::bezierPathWithOvalInRect(NSRect::new(
            NSPoint::new(center.x - RADIUS, center.y - RADIUS),
            NSSize::new(RADIUS * 2.0, RADIUS * 2.0),
        ));
        ring.setLineWidth(1.7);
        macos_color(color, 0.36).setStroke();
        ring.stroke();
        if let Some(weekly) = percentage(weekly).filter(|weekly| *weekly > 0.0) {
            let progress = NSBezierPath::bezierPath();
            progress.setLineWidth(1.7);
            progress.appendBezierPathWithArcWithCenter_radius_startAngle_endAngle_clockwise(
                center,
                RADIUS,
                90.0,
                90.0 - 360.0 * weekly / 100.0,
                true,
            );
            macos_color(color, 1.0).setStroke();
            progress.stroke();
        }
        true.into()
    });
    NSImage::imageWithSize_flipped_drawingHandler(NSSize::new(SIZE, SIZE), false, &draw)
}

#[cfg(target_os = "macos")]
fn macos_color(
    (red, green, blue): (u8, u8, u8),
    alpha: f64,
) -> objc2::rc::Retained<objc2_app_kit::NSColor> {
    objc2_app_kit::NSColor::colorWithSRGBRed_green_blue_alpha(
        f64::from(red) / 255.0,
        f64::from(green) / 255.0,
        f64::from(blue) / 255.0,
        alpha,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_keeps_each_enabled_pool_and_never_substitutes_weekly_for_five_hour() {
        let quotas: Quotas = serde_json::from_str(
            r#"{
            "codex":{"weekly":70,"fiveHour":null},
            "gemini":{"weekly":91,"fiveHour":0},
            "geminiShared":{"weekly":55,"fiveHour":80}
        }"#,
        )
        .unwrap();
        assert_eq!(
            quotas.tooltip(true),
            "Codex · Week 70% · 5h left —\nGemini · Week 91% · 5h left 0%\nGemini · Claude / GPT · Week 55% · 5h left 80%"
        );
    }
}

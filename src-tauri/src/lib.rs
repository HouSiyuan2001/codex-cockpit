mod antigravity;
mod app_icon;
mod app_updater;
#[cfg(target_os = "macos")]
mod capsule_glass;
mod claude_quota;
mod claude_quota_sync;
mod claude_resets;
mod claude_usage;
mod cloud_sync;
mod codex;
mod codex_project_usage;
mod comfort_sync;
mod gemini_quota;
mod gemini_quota_sync;
mod gemini_usage;
#[cfg(target_os = "linux")]
mod linux_window;
mod local_usage;
mod models;
mod provider_usage_sync;
mod qoder;
mod quota_tray;
mod reset_forecast;
mod shared_settings;
mod task_sync;
mod tokei_usage;
mod trae;
mod usage_sync;
mod usage_sync_git;
mod usage_sync_snapshot;
mod usage_time;
mod volcengine;
mod website_reset_probability;
mod workbuddy;

#[cfg(target_os = "macos")]
use capsule_glass::set_capsule_glass;
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_capsule_glass() -> bool {
    false
}

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSNormalWindowLevel, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect, NSSize};

#[cfg(any(
    debug_assertions,
    target_os = "macos",
    target_os = "windows",
    target_os = "linux",
    test
))]
use models::UsageWindow;
use models::{ProviderSnapshot, WidgetPreferences};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::Builder as WindowStateBuilder;

const COLLAPSED_LOGICAL_WIDTH: f64 = 92.0;
const COLLAPSED_LOGICAL_HEIGHT: f64 = 92.0;
const CAPSULE_LOGICAL_WIDTH: f64 = 88.0;
// The AI capsule contains two readings. Match aiCapsuleLogicalWidth in QuotaCard.tsx.
const CAPSULE_MAX_LOGICAL_WIDTH: f64 = 320.0;
const CAPSULE_LOGICAL_HEIGHT: f64 = 40.0;
const CAPSULE_MAX_LOGICAL_HEIGHT: f64 = 88.0;
const ISLAND_LOGICAL_WIDTH: f64 = 400.0;
const ISLAND_LOGICAL_HEIGHT: f64 = 38.0;
const EXPANDED_LOGICAL_WIDTH: f64 = 520.0;
const EXPANDED_LOGICAL_HEIGHT: f64 = 640.0;
const CONTROL_CENTER_LOGICAL_WIDTH: f64 = 560.0;
const CONTROL_CENTER_CALENDAR_LOGICAL_WIDTH: f64 = 940.0;
const CONTROL_CENTER_LOGICAL_HEIGHT: f64 = 600.0;
const MIN_EXPANDED_LOGICAL_HEIGHT: f64 = 160.0;
const MAX_EXPANDED_LOGICAL_HEIGHT: f64 = 1_200.0;
const EDGE_SAFE_INSET_LOGICAL: f64 = 4.0;
const SNAP_THRESHOLD_LOGICAL: f64 = 24.0;
const POSITION_EPSILON: u32 = 2;
const EXPAND_TRANSITION_MS: u64 = 280;
const COLLAPSE_TRANSITION_MS: u64 = 220;
#[cfg(any(not(target_os = "windows"), test))]
const SMOOTH_TRANSITION_FRAME_MS: u64 = 16;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_TRANSITION_FRAME_MS: u64 = 32;
#[cfg(target_os = "windows")]
const WIDGET_TRANSITION_FRAME_MS: u64 = WINDOWS_TRANSITION_FRAME_MS;
#[cfg(not(target_os = "windows"))]
const WIDGET_TRANSITION_FRAME_MS: u64 = SMOOTH_TRANSITION_FRAME_MS;
const BACKGROUND_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const BACKGROUND_FIRST_REFRESH_DELAY: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MacosWindowPresencePolicy {
    level: isize,
    collection_behavior: NSWindowCollectionBehavior,
    hides_on_deactivate: bool,
    can_hide: bool,
}

#[cfg(target_os = "macos")]
fn macos_window_presence_policy(always_on_top: bool) -> MacosWindowPresencePolicy {
    let (level, collection_behavior) = if always_on_top {
        (
            NSStatusWindowLevel,
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        )
    } else {
        (NSNormalWindowLevel, NSWindowCollectionBehavior::Default)
    };
    MacosWindowPresencePolicy {
        level,
        collection_behavior,
        hides_on_deactivate: false,
        can_hide: false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HorizontalDock {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VerticalDock {
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DockState {
    horizontal: Option<HorizontalDock>,
    vertical: Option<VerticalDock>,
}

impl DockState {
    fn is_docked(self) -> bool {
        self.horizontal.is_some() || self.vertical.is_some()
    }
}

#[derive(Clone, Copy, Serialize)]
struct WidgetRect {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetMorphGeometry {
    from: WidgetRect,
    to: WidgetRect,
    scale_factor: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_ticket: Option<u64>,
}

#[cfg(target_os = "windows")]
fn set_widget_frame_cloaked(window: &tauri::WebviewWindow, cloaked: bool) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{DwmFlush, DwmSetWindowAttribute, DWMWA_CLOAK};
    let handle = window
        .hwnd()
        .map_err(|_| "widget handle unavailable".to_string())?;
    let value = i32::from(cloaked);
    // JS coordinates do not invalidate a DWM-cached WebView surface. Cloak
    // before moving the HWND; uncloak only after the new masked frame paints.
    if !cloaked {
        unsafe {
            DwmFlush();
        }
    }
    let result = unsafe {
        DwmSetWindowAttribute(
            handle.0 as _,
            DWMWA_CLOAK as u32,
            (&value as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        )
    };
    if result < 0 {
        return Err("failed to mask widget frame".to_string());
    }
    unsafe {
        DwmFlush();
    }
    Ok(())
}

fn release_widget_frame(window: &tauri::WebviewWindow, ticket: u64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let state = window.state::<AppState>();
        let mut pending = state
            .frame_mask
            .lock()
            .map_err(|_| "widget frame unavailable".to_string())?;
        if *pending == Some(ticket) {
            set_widget_frame_cloaked(window, false)?;
            *pending = None;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, ticket);
    Ok(())
}

fn mask_widget_frame(window: &tauri::WebviewWindow, ticket: u64) -> Result<Option<u64>, String> {
    #[cfg(target_os = "windows")]
    {
        let state = window.state::<AppState>();
        let mut pending = state
            .frame_mask
            .lock()
            .map_err(|_| "widget frame unavailable".to_string())?;
        set_widget_frame_cloaked(window, true)?;
        *pending = Some(ticket);
        // Native recovery is independent of JS timers/rAF: a crashed or stopped
        // renderer must not leave the widget permanently cloaked. Ticket checks
        // prevent an old watchdog from revealing a newer frame swap.
        let recovery_window = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1_200));
            let _ = release_widget_frame(&recovery_window, ticket);
        });
        Ok(Some(ticket))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, ticket);
        Ok(None)
    }
}

#[tauri::command(async)]
fn reveal_widget_frame(frame_ticket: u64, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    release_widget_frame(&window, frame_ticket)
}

fn apply_compositor_bounds(window: &tauri::WebviewWindow, rect: WidgetRect) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let handle = window
            .hwnd()
            .map_err(|_| "widget handle unavailable".to_string())?;
        // Set both origin and extent atomically. The WebView animates its own
        // rounded mask; native resize/repaint never runs on every visual frame.
        let changed = unsafe {
            SetWindowPos(
                handle.0 as _,
                std::ptr::null_mut(),
                rect.position.x,
                rect.position.y,
                rect.size.width as i32,
                rect.size.height as i32,
                SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        };
        if changed == 0 {
            return Err("failed to set widget bounds".to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        window
            .set_size(rect.size)
            .map_err(|_| "failed to resize widget".to_string())?;
        window
            .set_position(rect.position)
            .map_err(|_| "failed to position widget".to_string())?;
    }
    Ok(())
}

fn finish_widget_motion(
    window: &tauri::WebviewWindow,
    from: WidgetRect,
    to: WidgetRect,
    generation: &AtomicU64,
    ticket: u64,
    compositor_motion: bool,
    preview: bool,
) -> Result<Option<WidgetMorphGeometry>, String> {
    if generation.load(Ordering::SeqCst) != ticket {
        return Ok(None);
    }
    let mut frame_ticket = None;
    if !preview {
        if compositor_motion {
            if to.size.width > from.size.width {
                frame_ticket = mask_widget_frame(window, ticket)?;
            }
            if let Err(error) = apply_compositor_bounds(window, to) {
                if let Some(ticket) = frame_ticket {
                    let _ = release_widget_frame(window, ticket);
                }
                return Err(error);
            }
        } else {
            animate_window_to(window, from, to, generation, ticket)?;
        }
    }
    Ok(Some(WidgetMorphGeometry {
        from,
        to,
        scale_factor: window.scale_factor().unwrap_or(1.0),
        frame_ticket,
    }))
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaPoint {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaSize {
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaPayload {
    position: WorkAreaPoint,
    size: WorkAreaSize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WidgetMode {
    Collapsed,
    Expanded,
}

fn drag_completion_mode(
    started_mode: Option<WidgetMode>,
    current_mode: WidgetMode,
) -> Option<WidgetMode> {
    match started_mode {
        Some(mode) if mode != current_mode => None,
        Some(mode) => Some(mode),
        None => Some(current_mode),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompactMode {
    Float,
    Capsule,
    Island,
}

#[derive(Clone, Copy)]
struct WidgetGeometryState {
    mode: WidgetMode,
    compact_mode: CompactMode,
    dock: DockState,
    collapsed_rect: WidgetRect,
    expanded_rect: Option<WidgetRect>,
    user_moved_expanded: bool,
}

fn compact_mode(compact_layout: Option<&str>) -> CompactMode {
    match compact_layout {
        Some("bar" | "island") => CompactMode::Island,
        Some("capsule") => CompactMode::Capsule,
        _ => CompactMode::Float,
    }
}

fn collapsed_physical_size(
    compact_mode: CompactMode,
    scale_factor: f64,
    safe_inset: u32,
) -> PhysicalSize<u32> {
    collapsed_physical_size_with_width(compact_mode, scale_factor, safe_inset, None)
}

fn collapsed_physical_size_with_width(
    compact_mode: CompactMode,
    scale_factor: f64,
    safe_inset: u32,
    capsule_width: Option<f64>,
) -> PhysicalSize<u32> {
    collapsed_physical_size_with_dimensions(
        compact_mode,
        scale_factor,
        safe_inset,
        capsule_width,
        None,
    )
}

fn collapsed_physical_size_with_dimensions(
    compact_mode: CompactMode,
    scale_factor: f64,
    safe_inset: u32,
    capsule_width: Option<f64>,
    capsule_height: Option<f64>,
) -> PhysicalSize<u32> {
    let (width, height) = match compact_mode {
        CompactMode::Float => (COLLAPSED_LOGICAL_WIDTH, COLLAPSED_LOGICAL_HEIGHT),
        CompactMode::Capsule => (
            capsule_width
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(CAPSULE_LOGICAL_WIDTH, CAPSULE_MAX_LOGICAL_WIDTH))
                .unwrap_or(CAPSULE_LOGICAL_WIDTH),
            capsule_height
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(CAPSULE_LOGICAL_HEIGHT, CAPSULE_MAX_LOGICAL_HEIGHT))
                .unwrap_or(CAPSULE_LOGICAL_HEIGHT),
        ),
        CompactMode::Island => (ISLAND_LOGICAL_WIDTH, ISLAND_LOGICAL_HEIGHT),
    };
    PhysicalSize::new(
        widget_window_size(width, scale_factor, safe_inset),
        widget_window_size(height, scale_factor, safe_inset),
    )
}

pub(crate) fn credentials_disabled_for_preview() -> bool {
    std::env::var_os("CODEX_COCKPIT_TEST_NO_KEYCHAIN").is_some_and(|value| value == "1")
        && std::env::var_os("CODEX_COCKPIT_CONFIG_DIR")
            .is_some_and(|path| std::path::Path::new(&path).is_absolute())
}

pub(crate) fn app_config_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    if let Some(custom) = std::env::var_os("CODEX_COCKPIT_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(custom);
    }
    app.path().app_config_dir()
}

struct AppState {
    client: reqwest::Client,
    preferences: Mutex<WidgetPreferences>,
    preferences_path: PathBuf,
    runtime_state_path: PathBuf,
    fetch_lock: tokio::sync::Mutex<()>,
    snapshot_cache: Mutex<Option<(Instant, Vec<ProviderSnapshot>)>>,
    #[cfg(debug_assertions)]
    simulate_short_window_for_testing: Mutex<bool>,
    window_geometry_lock: Mutex<()>,
    transition_generation: AtomicU64,
    #[cfg(target_os = "windows")]
    frame_mask: Mutex<Option<u64>>,
    control_center_owner: Mutex<bool>,
    geometry: Mutex<Option<WidgetGeometryState>>,
    drag_mode: Mutex<Option<WidgetMode>>,
    #[cfg(target_os = "macos")]
    drag_origin: Mutex<Option<NSRect>>,
}

// Reserve dialog ownership and a generation atomically. A rejected widget
// request must not even cancel the dialog animation already in flight.
fn reserve_geometry_transition(
    owner: &Mutex<bool>,
    generation: &AtomicU64,
    control_center: bool,
) -> Result<Option<u64>, String> {
    let mut owner = owner
        .lock()
        .map_err(|_| "window owner unavailable".to_string())?;
    if *owner && !control_center {
        return Ok(None);
    }
    if control_center {
        *owner = true;
    }
    Ok(Some(generation.fetch_add(1, Ordering::SeqCst) + 1))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDiagnostics {
    app_version: &'static str,
    platform: &'static str,
    config_directory: String,
    preferences_backup_available: bool,
    runtime_backup_available: bool,
}

fn apply_short_window_test_override(
    _state: &AppState,
    #[allow(unused_mut)] mut snapshots: Vec<ProviderSnapshot>,
) -> Vec<ProviderSnapshot> {
    #[cfg(debug_assertions)]
    if _state
        .simulate_short_window_for_testing
        .lock()
        .map(|value| *value)
        .unwrap_or(false)
    {
        for snapshot in &mut snapshots {
            if snapshot.status == "ok" {
                snapshot.short_window = Some(UsageWindow {
                    remaining_percent: 88.0,
                    resets_at: Some((chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339()),
                    window_seconds: 18_000,
                });
            }
        }
    }
    snapshots
}

async fn collect_snapshots_once(client: &reqwest::Client) -> Vec<ProviderSnapshot> {
    if let Some(fixture_path) = std::env::var_os("CODEX_COCKPIT_CODEX_FIXTURE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        if let Ok(raw) = fs::read_to_string(&fixture_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                let remaining = value
                    .get("remainingPercent")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(74.0)
                    .clamp(0.0, 100.0);
                let resets_at = value
                    .get("resetsAt")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                return vec![ProviderSnapshot {
                    provider: "codex".into(),
                    display_name: "CODEX".into(),
                    plan: value
                        .get("plan")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    short_window: value
                        .get("fiveHourRemainingPercent")
                        .and_then(serde_json::Value::as_f64)
                        .map(|remaining_percent| UsageWindow {
                            remaining_percent,
                            resets_at: value
                                .get("fiveHourResetsAt")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string),
                            window_seconds: 18_000,
                        }),
                    weekly_window: Some(UsageWindow {
                        remaining_percent: remaining,
                        resets_at,
                        window_seconds: 604_800,
                    }),
                    monthly_window: None,
                    reset_credits: Some(1),
                    reset_credit_expires_at: Vec::new(),
                    balance_remaining: None,
                    balance_unit: None,
                    rate_limit_snapshot: None,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    status: "ok".into(),
                    message: None,
                }];
            }
        }
    }
    let qoder_snapshot = qoder::fetch_snapshot();
    let (
        codex_snapshot,
        trae_snapshot,
        workbuddy_snapshot,
        volcengine_snapshot,
        antigravity_snapshot,
    ) = tokio::join!(
        codex::fetch_snapshot(client),
        trae::fetch_snapshot(client),
        workbuddy::fetch_snapshot(client),
        volcengine::fetch_snapshot(),
        antigravity::fetch_snapshot(),
    );
    let mut values = vec![codex_snapshot];
    values.extend(qoder_snapshot);
    values.extend(trae_snapshot);
    values.extend(workbuddy_snapshot);
    values.extend(volcengine_snapshot);
    values.extend(antigravity_snapshot);
    values
}

async fn collect_snapshots(client: &reqwest::Client) -> Vec<ProviderSnapshot> {
    let mut values = collect_snapshots_once(client).await;
    for delay in [400_u64, 1_200_u64] {
        let retryable = values.iter().any(|snapshot| {
            matches!(
                snapshot.status.as_str(),
                "unavailable" | "stale" | "loading"
            )
        });
        if !retryable {
            break;
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
        let retried = collect_snapshots_once(client).await;
        for current in &mut values {
            if !matches!(current.status.as_str(), "unavailable" | "stale" | "loading") {
                continue;
            }
            if let Some(candidate) = retried
                .iter()
                .find(|candidate| candidate.provider == current.provider)
            {
                *current = candidate.clone();
            }
        }
    }
    values
}

// Callers hold fetch_lock so background and foreground refreshes share the
// same prior observation before deciding whether to send a message.
async fn refresh_snapshot_cache(state: &AppState) -> Vec<ProviderSnapshot> {
    let mut values = collect_snapshots(&state.client).await;
    let enabled = state.preferences.lock().is_ok_and(|preferences| {
        preferences.codex_enabled && preferences.auto_refresh_five_hour_quota
    });
    if enabled && !credentials_disabled_for_preview() {
        let previous = state.snapshot_cache.lock().ok().and_then(|cache| {
            cache
                .as_ref()?
                .1
                .iter()
                .find(|snapshot| snapshot.provider == "codex")
                .cloned()
        });
        if let (Some(previous), Some(current)) = (
            previous,
            values
                .iter_mut()
                .find(|snapshot| snapshot.provider == "codex"),
        ) {
            codex::maybe_refresh_five_hour_window(&state.client, &previous, current).await;
        }
    }
    if let Ok(mut cache) = state.snapshot_cache.lock() {
        *cache = Some((Instant::now(), values.clone()));
    }
    values
}

async fn refresh_snapshots_in_background(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _guard = state.fetch_lock.lock().await;
    let values = refresh_snapshot_cache(&state).await;
    let values = apply_short_window_test_override(&state, values);
    let _ = app.emit_to("widget", "background-snapshots-updated", values);
}

async fn run_background_refresh_loop(app: AppHandle) {
    tokio::time::sleep(BACKGROUND_FIRST_REFRESH_DELAY).await;
    loop {
        refresh_snapshots_in_background(&app).await;
        tokio::time::sleep(BACKGROUND_REFRESH_INTERVAL).await;
    }
}

async fn fetch_snapshots_uncached(state: &State<'_, AppState>) -> Vec<ProviderSnapshot> {
    let _guard = state.fetch_lock.lock().await;
    let values = refresh_snapshot_cache(state).await;
    apply_short_window_test_override(state.inner(), values)
}

fn load_preferences(path: &Path) -> WidgetPreferences {
    let parse = |candidate: &Path| {
        fs::read_to_string(candidate)
            .ok()
            .and_then(|raw| WidgetPreferences::from_disk_json(&raw).ok())
    };
    if let Some(value) = parse(path) {
        return value.normalized();
    }
    let backup = path.with_extension("json.bak");
    if let Some(value) = parse(&backup) {
        eprintln!("preferences recovered from backup");
        return value.normalized();
    }
    WidgetPreferences::default()
}

fn persist_preferences(path: &Path, value: &WidgetPreferences) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "failed to create settings directory".to_string())?;
    }
    let serialized =
        serde_json::to_vec_pretty(value).map_err(|_| "failed to serialize settings".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "failed to create temporary settings file".to_string())?;
    file.write_all(&serialized)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to write settings".to_string())?;
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|_| "failed to back up settings".to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        return Err(format!("failed to commit settings: {error}"));
    }
    Ok(())
}

fn persist_json_value(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "failed to create data directory".to_string())?;
    }
    let serialized = serde_json::to_vec_pretty(value)
        .map_err(|_| "failed to serialize application data".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "failed to create temporary data file".to_string())?;
    file.write_all(&serialized)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to write application data".to_string())?;
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|_| "failed to back up application data".to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        return Err(format!("failed to commit application data: {error}"));
    }
    Ok(())
}

fn read_json_with_backup(path: &Path) -> serde_json::Value {
    [path.to_path_buf(), path.with_extension("json.bak")]
        .into_iter()
        .find_map(|candidate| {
            fs::read_to_string(candidate)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
        })
        .unwrap_or_else(|| {
            serde_json::json!({
                "schemaVersion": 1,
                "history": [],
                "dailyUsage": [],
                "dailyRecommendations": [],
                "events": [],
                "savedLayouts": [],
                "lastNotifications": {}
            })
        })
}

#[tauri::command]
fn get_runtime_state(state: State<'_, AppState>) -> serde_json::Value {
    read_json_with_backup(&state.runtime_state_path)
}

#[tauri::command]
fn set_runtime_state(
    runtime_state: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    persist_json_value(&state.runtime_state_path, &runtime_state)
}

#[tauri::command]
fn export_app_data(path: String, bundle: serde_json::Value) -> Result<(), String> {
    let target = PathBuf::from(path);
    if target.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("backup file must use the .json extension".into());
    }
    persist_json_value(&target, &bundle)
}

#[tauri::command]
fn import_app_data(path: String) -> Result<serde_json::Value, String> {
    let target = PathBuf::from(path);
    let raw = fs::read_to_string(target).map_err(|_| "failed to read backup file".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "backup file is not valid JSON".to_string())
}

#[tauri::command]
fn create_automatic_backup(
    bundle: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config_dir = state
        .preferences_path
        .parent()
        .ok_or_else(|| "settings directory unavailable".to_string())?;
    let backup_dir = config_dir.join("backups");
    fs::create_dir_all(&backup_dir).map_err(|_| "failed to create backup directory".to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let target = backup_dir.join(format!("quota-float-{stamp}.json"));
    persist_json_value(&target, &bundle)?;

    let mut backups = fs::read_dir(&backup_dir)
        .map_err(|_| "failed to list backups".to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    backups.sort();
    let remove_count = backups.len().saturating_sub(10);
    for old in backups.into_iter().take(remove_count) {
        let _ = fs::remove_file(old);
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn restore_latest_backup(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config_dir = state
        .preferences_path
        .parent()
        .ok_or_else(|| "settings directory unavailable".to_string())?;
    let backup_dir = config_dir.join("backups");
    let mut backups = fs::read_dir(backup_dir)
        .map_err(|_| "no automatic backup is available".to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    backups.sort();
    let latest = backups
        .pop()
        .ok_or_else(|| "no automatic backup is available".to_string())?;
    let raw =
        fs::read_to_string(latest).map_err(|_| "failed to read automatic backup".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "automatic backup is invalid".to_string())
}

#[tauri::command]
fn get_app_diagnostics(state: State<'_, AppState>) -> AppDiagnostics {
    let config_directory = state
        .preferences_path
        .parent()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    AppDiagnostics {
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        config_directory,
        preferences_backup_available: state.preferences_path.with_extension("json.bak").exists(),
        runtime_backup_available: state.runtime_state_path.with_extension("json.bak").exists(),
    }
}

#[tauri::command]
async fn get_snapshots(state: State<'_, AppState>) -> Result<Vec<ProviderSnapshot>, String> {
    const CACHE_TTL: Duration = Duration::from_secs(30);
    if let Ok(cache) = state.snapshot_cache.lock() {
        if let Some((time, values)) = &*cache {
            if time.elapsed() < CACHE_TTL {
                return Ok(apply_short_window_test_override(&state, values.clone()));
            }
        }
    }
    let _guard = match state.fetch_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            if let Ok(cache) = state.snapshot_cache.lock() {
                if let Some((_, values)) = &*cache {
                    return Ok(apply_short_window_test_override(&state, values.clone()));
                }
            }
            return Ok(vec![ProviderSnapshot::failure(
                "unavailable",
                "Quota refresh is already running.",
            )]);
        }
    };
    if let Ok(cache) = state.snapshot_cache.lock() {
        if let Some((time, values)) = &*cache {
            if time.elapsed() < CACHE_TTL {
                return Ok(apply_short_window_test_override(&state, values.clone()));
            }
        }
    }
    let values = refresh_snapshot_cache(&state).await;
    Ok(apply_short_window_test_override(&state, values))
}

#[tauri::command]
async fn refresh_snapshots(state: State<'_, AppState>) -> Result<Vec<ProviderSnapshot>, String> {
    let values = fetch_snapshots_uncached(&state).await;
    Ok(values)
}

#[tauri::command]
async fn get_codex_reset_forecast(
    state: State<'_, AppState>,
) -> Result<Option<reset_forecast::ResetForecast>, String> {
    Ok(reset_forecast::fetch(&state.client).await)
}

#[tauri::command]
fn get_codex_daily_usage() -> codex::DailyQuotaUsage {
    codex::read_today_usage()
}

#[tauri::command]
async fn get_codex_website_reset_probability(
    state: State<'_, AppState>,
) -> Result<Option<website_reset_probability::WebsiteResetProbability>, String> {
    Ok(website_reset_probability::fetch(&state.client).await)
}

#[tauri::command]
async fn get_claude_quota(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: Option<bool>,
) -> Result<claude_quota::ClaudeQuota, String> {
    let refresh_message = state.preferences.lock().is_ok_and(|preferences| {
        preferences.claude_enabled && preferences.auto_refresh_five_hour_quota
    });
    let quota = claude_quota::fetch(&state.client, manual.unwrap_or(false), refresh_message).await;
    if let Ok(data) = app_config_dir(&app) {
        let _ = claude_quota_sync::remember(&data, &quota);
    }
    Ok(quota)
}

#[tauri::command]
async fn login_claude_code() -> Result<(), String> {
    claude_quota::login().await.map_err(str::to_owned)
}

#[tauri::command]
async fn get_claude_reset_forecast(
    state: State<'_, AppState>,
    plan: Option<String>,
) -> Result<Option<claude_resets::ClaudeResetForecast>, String> {
    Ok(claude_resets::fetch(&state.client, plan.as_deref()).await)
}

#[tauri::command(async)]
fn get_claude_usage(days: Option<u32>) -> claude_usage::ClaudeUsageReport {
    claude_usage::read_usage(days.unwrap_or(35))
}

#[tauri::command]
async fn get_gemini_usage(days: Option<u32>) -> Result<claude_usage::ClaudeUsageReport, String> {
    tauri::async_runtime::spawn_blocking(move || gemini_usage::read_usage(days.unwrap_or(35)))
        .await
        .map_err(|_| "gemini_usage_unavailable".into())
}

pub fn capture_antigravity_statusline_quota() {
    gemini_quota::capture_statusline_quota();
}

#[tauri::command]
async fn get_gemini_quota(
    app: AppHandle,
    state: State<'_, AppState>,
    manual: Option<bool>,
) -> Result<gemini_quota::GeminiQuota, String> {
    let auto_refresh = state.preferences.lock().is_ok_and(|preferences| {
        preferences.gemini_enabled && preferences.auto_refresh_five_hour_quota
    });
    let quota = gemini_quota::fetch(manual.unwrap_or(false), auto_refresh).await;
    if let Ok(data) = app_config_dir(&app) {
        let _ = gemini_quota_sync::remember(&data, &quota);
    }
    Ok(quota)
}

#[tauri::command]
fn report_preview_metrics(metrics: serde_json::Value, app: AppHandle) -> Result<(), String> {
    let isolated = std::env::var_os("CODEX_COCKPIT_CONFIG_DIR")
        .map(PathBuf::from)
        .is_some_and(|path| path.is_absolute());
    let Some(target) = isolated
        .then(|| std::env::var_os("CODEX_COCKPIT_PREVIEW_METRICS_PATH"))
        .flatten()
        .map(PathBuf::from)
    else {
        return Ok(());
    };
    let mut payload = metrics;
    if let Some(window) = app.get_webview_window("widget") {
        if let (Ok(pos), Ok(size), Ok((_, scale))) = (
            window.outer_position(),
            window.outer_size(),
            monitor_and_scale(&window),
        ) {
            payload["nativeWindow"] = serde_json::json!({
                "x": pos.x,
                "y": pos.y,
                "width": size.width,
                "height": size.height,
                "scaleFactor": scale,
            });
        }
    }
    persist_json_value(&target, &payload)
}

#[tauri::command]
fn get_codex_daily_usage_history() -> Vec<codex::DailyQuotaUsage> {
    codex::read_usage_history(90)
}

#[tauri::command]
async fn get_volcengine_diagnostics() -> volcengine::VolcengineDiagnostics {
    volcengine::diagnostics().await
}

#[tauri::command]
async fn reconnect_volcengine(
    state: State<'_, AppState>,
) -> Result<volcengine::VolcengineDiagnostics, String> {
    let _guard = state.fetch_lock.lock().await;
    volcengine::reconnect().await?;
    if let Ok(mut cache) = state.snapshot_cache.lock() {
        *cache = None;
    }
    Ok(volcengine::diagnostics().await)
}

fn clamp_position_to_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let left = monitor_position.x;
    let top = monitor_position.y;
    let right = left + monitor_size.width as i32;
    let bottom = top + monitor_size.height as i32;
    PhysicalPosition::new(
        position
            .x
            .clamp(left - safe_inset, right - size.width as i32 + safe_inset),
        position
            .y
            .clamp(top - safe_inset, bottom - size.height as i32 + safe_inset),
    )
}

fn logical_to_physical(value: f64, scale_factor: f64) -> u32 {
    (value * scale_factor).round().max(1.0) as u32
}

fn window_size_for_visual_size(visual_size: u32, safe_inset: u32) -> u32 {
    visual_size + safe_inset * 2
}

fn widget_window_size(logical_visual_size: f64, scale_factor: f64, safe_inset: u32) -> u32 {
    window_size_for_visual_size(
        logical_to_physical(logical_visual_size, scale_factor),
        safe_inset,
    )
}

fn bounded_expanded_height(
    content_height: f64,
    scale_factor: f64,
    safe_inset: u32,
    bounds_height: Option<u32>,
) -> u32 {
    let logical_height = if content_height.is_finite() {
        content_height.clamp(MIN_EXPANDED_LOGICAL_HEIGHT, MAX_EXPANDED_LOGICAL_HEIGHT)
    } else {
        EXPANDED_LOGICAL_HEIGHT
    };
    let requested = widget_window_size(logical_height, scale_factor, safe_inset);
    let Some(bounds_height) = bounds_height else {
        return requested;
    };
    let maximum = bounds_height.saturating_add(safe_inset.saturating_mul(2));
    let minimum =
        widget_window_size(MIN_EXPANDED_LOGICAL_HEIGHT, scale_factor, safe_inset).min(maximum);
    requested.min(maximum).max(minimum)
}

fn clamp_position_to_bounds(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let right = bounds_position.x + bounds_size.width as i32;
    let bottom = bounds_position.y + bounds_size.height as i32;
    let min_x = bounds_position.x - safe_inset;
    let min_y = bounds_position.y - safe_inset;
    let max_x = (right - size.width as i32 + safe_inset).max(min_x);
    let max_y = (bottom - size.height as i32 + safe_inset).max(min_y);
    PhysicalPosition::new(
        position.x.clamp(min_x, max_x),
        position.y.clamp(min_y, max_y),
    )
}

fn resize_from_top_in_bounds(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: u32,
    minimum_height: u32,
) -> WidgetRect {
    // Monitor selection can change as an expanded window straddles displays.
    // A vertical resize must leave the horizontal position of the switch alone.
    let top = bounds_position.y - safe_inset as i32;
    let bottom = bounds_position.y + bounds_size.height as i32 + safe_inset as i32;
    let latest_top = (bottom - size.height.min(minimum_height) as i32).max(top);
    let position = PhysicalPosition::new(position.x, position.y.clamp(top, latest_top));
    WidgetRect {
        position,
        size: PhysicalSize::new(
            size.width,
            size.height.min((bottom - position.y).max(0) as u32),
        ),
    }
}

fn centered_dialog_position_in_bounds(
    size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let visual_width = size
        .width
        .saturating_sub((safe_inset.max(0) as u32).saturating_mul(2));
    let visual_height = size
        .height
        .saturating_sub((safe_inset.max(0) as u32).saturating_mul(2));
    PhysicalPosition::new(
        bounds_position.x + (bounds_size.width.saturating_sub(visual_width) / 2) as i32
            - safe_inset,
        bounds_position.y + (bounds_size.height.saturating_sub(visual_height) / 2) as i32
            - safe_inset,
    )
}

fn detect_dock(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    threshold: i32,
    safe_inset: i32,
) -> DockState {
    detect_dock_in_bounds(
        position,
        size,
        *monitor.position(),
        *monitor.size(),
        threshold,
        safe_inset,
    )
}

fn detect_dock_in_bounds(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    threshold: i32,
    safe_inset: i32,
) -> DockState {
    let visible_left = position.x + safe_inset;
    let visible_top = position.y + safe_inset;
    let visible_right = position.x + size.width as i32 - safe_inset;
    let visible_bottom = position.y + size.height as i32 - safe_inset;
    let left_distance = (visible_left - bounds_position.x).abs();
    let top_distance = (visible_top - bounds_position.y).abs();
    let right_distance = (bounds_position.x + bounds_size.width as i32 - visible_right).abs();
    let bottom_distance = (bounds_position.y + bounds_size.height as i32 - visible_bottom).abs();
    let horizontal = if left_distance <= threshold || right_distance <= threshold {
        if left_distance <= right_distance {
            Some(HorizontalDock::Left)
        } else {
            Some(HorizontalDock::Right)
        }
    } else {
        None
    };
    let vertical = if top_distance <= threshold || bottom_distance <= threshold {
        if top_distance <= bottom_distance {
            Some(VerticalDock::Top)
        } else {
            Some(VerticalDock::Bottom)
        }
    } else {
        None
    };
    DockState {
        horizontal,
        vertical,
    }
}

fn snap_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    dock: DockState,
    monitor: &tauri::Monitor,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    snap_position_in_bounds(
        position,
        size,
        dock,
        *monitor.position(),
        *monitor.size(),
        safe_inset,
    )
}

fn snap_position_in_bounds(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    dock: DockState,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let mut next =
        clamp_position_to_bounds(position, size, bounds_position, bounds_size, safe_inset);
    match dock.horizontal {
        Some(HorizontalDock::Left) => next.x = bounds_position.x - safe_inset,
        Some(HorizontalDock::Right) => {
            next.x = bounds_position.x + bounds_size.width as i32 - size.width as i32 + safe_inset
        }
        None => {}
    }
    match dock.vertical {
        Some(VerticalDock::Top) => next.y = bounds_position.y - safe_inset,
        Some(VerticalDock::Bottom) => {
            next.y = bounds_position.y + bounds_size.height as i32 - size.height as i32 + safe_inset
        }
        None => {}
    }
    next
}

fn expanded_position_in_bounds(
    collapsed: WidgetRect,
    expanded_size: PhysicalSize<u32>,
    dock: DockState,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let monitor_right = bounds_position.x + bounds_size.width as i32;
    let monitor_bottom = bounds_position.y + bounds_size.height as i32;
    let collapsed_left = collapsed.position.x + safe_inset;
    let collapsed_top = collapsed.position.y + safe_inset;
    let collapsed_right = collapsed.position.x + collapsed.size.width as i32 - safe_inset;
    let collapsed_bottom = collapsed.position.y + collapsed.size.height as i32 - safe_inset;
    let x = match dock.horizontal {
        Some(HorizontalDock::Left) => collapsed_left - safe_inset,
        Some(HorizontalDock::Right) => collapsed_right - expanded_size.width as i32 + safe_inset,
        None => {
            collapsed.position.x + (collapsed.size.width as i32 - expanded_size.width as i32) / 2
        }
    };
    let y = match dock.vertical {
        Some(VerticalDock::Top) => collapsed_top - safe_inset,
        Some(VerticalDock::Bottom) => collapsed_bottom - expanded_size.height as i32 + safe_inset,
        None => collapsed.position.y,
    };
    let min_x = bounds_position.x - safe_inset;
    let min_y = bounds_position.y - safe_inset;
    let max_x = (monitor_right - expanded_size.width as i32 + safe_inset).max(min_x);
    let max_y = (monitor_bottom - expanded_size.height as i32 + safe_inset).max(min_y);
    PhysicalPosition::new(x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn smooth_transition_progress(progress: f64) -> f64 {
    let clamped = progress.clamp(0.0, 1.0);
    0.5 - 0.5 * (std::f64::consts::PI * clamped).cos()
}

fn interpolate_i32(start: i32, end: i32, progress: f64) -> i32 {
    (start as f64 + (end - start) as f64 * progress).round() as i32
}

fn interpolate_u32(start: u32, end: u32, progress: f64) -> u32 {
    (start as f64 + (end as f64 - start as f64) * progress).round() as u32
}

fn transition_frame_deadline(elapsed_ms: u64, duration_ms: u64, frame_ms: u64) -> u64 {
    debug_assert!(frame_ms > 0);
    let next_frame = elapsed_ms / frame_ms + 1;
    frame_ms.saturating_mul(next_frame).min(duration_ms)
}

#[cfg(target_os = "macos")]
fn cocoa_frame_for_widget_rect(
    initial_frame: NSRect,
    from: WidgetRect,
    to: WidgetRect,
    scale_factor: f64,
) -> NSRect {
    let scale = scale_factor.max(f64::EPSILON);
    let target_width = to.size.width as f64 / scale;
    let target_height = to.size.height as f64 / scale;
    let delta_x = (to.position.x - from.position.x) as f64 / scale;
    let delta_y = (to.position.y - from.position.y) as f64 / scale;
    NSRect::new(
        NSPoint::new(
            initial_frame.origin.x + delta_x,
            initial_frame.origin.y - delta_y - (target_height - initial_frame.size.height),
        ),
        NSSize::new(target_width, target_height),
    )
}

#[cfg(target_os = "macos")]
fn read_macos_window_frame(window: &tauri::WebviewWindow) -> Result<NSRect, String> {
    let window_ptr = window
        .ns_window()
        .map_err(|_| "failed to read native widget window".to_string())?
        as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let frame = unsafe { (&*(window_ptr as *const NSWindow)).frame() };
            let _ = sender.send(frame);
        })
        .map_err(|_| "failed to inspect native widget frame".to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "timed out reading native widget frame".to_string())
}

#[cfg(target_os = "macos")]
fn set_macos_window_frame(window: &tauri::WebviewWindow, frame: NSRect) -> Result<(), String> {
    let window_ptr = window
        .ns_window()
        .map_err(|_| "failed to read native widget window".to_string())?
        as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            unsafe { (&*(window_ptr as *const NSWindow)).setFrame_display(frame, true) };
            let _ = sender.send(());
        })
        .map_err(|_| "failed to schedule native widget frame".to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "timed out updating native widget frame".to_string())
}

/// A non-activating panel class for the widget.
///
/// macOS only lets a window join another app's full-screen Space when it is a
/// non-activating `NSPanel`; a plain `NSWindow` at any level stays behind on
/// the desktop Space. The subclass keeps the borderless widget able to take
/// keyboard focus for its text fields.
#[cfg(target_os = "macos")]
fn widget_panel_class() -> &'static objc2::runtime::AnyClass {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    static CLASS: std::sync::OnceLock<&'static AnyClass> = std::sync::OnceLock::new();
    extern "C-unwind" fn accepts(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::YES
    }
    CLASS.get_or_init(|| {
        let name = c"CodexCockpitWidgetPanel";
        if let Some(existing) = AnyClass::get(name) {
            return existing;
        }
        let mut builder = ClassBuilder::new(name, objc2::class!(NSPanel))
            .expect("widget panel class name is unique");
        unsafe {
            builder.add_method(
                objc2::sel!(canBecomeKeyWindow),
                accepts as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                objc2::sel!(canBecomeMainWindow),
                accepts as extern "C-unwind" fn(_, _) -> _,
            );
        }
        builder.register()
    })
}

/// Must run on the main thread. Idempotent.
#[cfg(target_os = "macos")]
fn promote_widget_to_panel(native_window: &NSWindow) {
    const NONACTIVATING_PANEL: usize = 1 << 7;
    let panel_class = widget_panel_class();
    let object = native_window as *const NSWindow as *mut objc2::runtime::AnyObject;
    unsafe {
        if !std::ptr::eq((*object).class(), panel_class) {
            objc2::ffi::object_setClass(object, panel_class);
        }
    }
    let mask = native_window.styleMask();
    if mask.0 & NONACTIVATING_PANEL == 0 {
        native_window.setStyleMask(objc2_app_kit::NSWindowStyleMask(
            mask.0 | NONACTIVATING_PANEL,
        ));
    }
}

#[cfg(target_os = "macos")]
fn apply_macos_window_presence(
    window: &tauri::WebviewWindow,
    always_on_top: bool,
) -> Result<(), String> {
    let window_ptr = window
        .ns_window()
        .map_err(|_| "failed to read native widget window".to_string())?
        as usize;
    let policy = macos_window_presence_policy(always_on_top);
    let apply_policy = move || {
        let native_window = unsafe { &*(window_ptr as *const NSWindow) };
        if always_on_top {
            promote_widget_to_panel(native_window);
        }
        native_window.setLevel(policy.level);
        native_window.setCollectionBehavior(policy.collection_behavior);
        native_window.setHidesOnDeactivate(policy.hides_on_deactivate);
        native_window.setCanHide(policy.can_hide);
    };
    if MainThreadMarker::new().is_some() {
        apply_policy();
        return Ok(());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            apply_policy();
            let _ = sender.send(());
        })
        .map_err(|_| "failed to schedule native widget presence policy".to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "timed out updating native widget presence policy".to_string())
}

fn apply_widget_window_presence(
    window: &tauri::WebviewWindow,
    always_on_top: bool,
) -> Result<(), String> {
    // Tao queues its generic level setter even when already on the main thread.
    // On macOS that queued Floating level would overwrite our native Status level
    // after this function returns. Keep a single owner of the native policy.
    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| format!("failed to toggle always-on-top: {error}"))?;
    #[cfg(target_os = "macos")]
    apply_macos_window_presence(window, always_on_top)?;
    #[cfg(target_os = "linux")]
    {
        let native_window = window.clone();
        window
            .run_on_main_thread(move || {
                use gtk::prelude::*;
                if let Ok(gtk_window) = native_window.gtk_window() {
                    // Reassert the native hint even when GTK's cached setting
                    // already matches: XWayland may lose it when mapping.
                    if let Some(surface) = gtk_window.window() {
                        surface.set_keep_above(always_on_top);
                    }
                }
            })
            .map_err(|error| format!("failed to apply Linux window presence: {error}"))?;
    }
    Ok(())
}

fn animate_window_to(
    window: &tauri::WebviewWindow,
    from: WidgetRect,
    to: WidgetRect,
    generation: &AtomicU64,
    ticket: u64,
) -> Result<(), String> {
    if from.position == to.position && from.size == to.size {
        return Ok(());
    }
    let expanding = to.size.width > from.size.width || to.size.height > from.size.height;
    let duration = Duration::from_millis(if expanding {
        EXPAND_TRANSITION_MS
    } else {
        COLLAPSE_TRANSITION_MS
    });
    #[cfg(target_os = "macos")]
    let native_animation = read_macos_window_frame(window)
        .ok()
        .map(|frame| (frame, window.scale_factor().unwrap_or(1.0)));

    let animation_started = Instant::now();
    // Without a compositor, intermediate X11 sizes expose unpainted WebKit
    // backing pixels as black strips. Apply one final geometry in that case.
    #[cfg(target_os = "linux")]
    let animate_geometry = linux_window::supports_geometry_animation();
    #[cfg(not(target_os = "linux"))]
    let animate_geometry = true;
    let mut last_applied = from;
    loop {
        if generation.load(Ordering::SeqCst) != ticket {
            return Ok(());
        }
        let linear = if animate_geometry {
            (animation_started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        } else {
            1.0
        };
        let progress = smooth_transition_progress(linear);
        let position = PhysicalPosition::new(
            interpolate_i32(from.position.x, to.position.x, progress),
            interpolate_i32(from.position.y, to.position.y, progress),
        );
        let size = PhysicalSize::new(
            interpolate_u32(from.size.width, to.size.width, progress),
            interpolate_u32(from.size.height, to.size.height, progress),
        );
        let rect = WidgetRect { position, size };
        let position_changed = position != last_applied.position;
        let size_changed = size != last_applied.size;
        #[cfg(target_os = "macos")]
        if position_changed || size_changed {
            if let Some((initial_frame, scale_factor)) = native_animation {
                set_macos_window_frame(
                    window,
                    cocoa_frame_for_widget_rect(initial_frame, from, rect, scale_factor),
                )?;
            } else if expanding {
                if size_changed {
                    window
                        .set_size(size)
                        .map_err(|_| "failed to resize widget".to_string())?;
                }
                if position_changed {
                    window
                        .set_position(position)
                        .map_err(|_| "failed to position widget".to_string())?;
                }
            } else {
                if position_changed {
                    window
                        .set_position(position)
                        .map_err(|_| "failed to position widget".to_string())?;
                }
                if size_changed {
                    window
                        .set_size(size)
                        .map_err(|_| "failed to resize widget".to_string())?;
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        if expanding && (position_changed || size_changed) {
            // Grow under the pointer before shifting the frame so a capsule
            // click cannot briefly fall outside the native window.
            if size_changed {
                window
                    .set_size(size)
                    .map_err(|_| "failed to resize widget".to_string())?;
            }
            if position_changed {
                window
                    .set_position(position)
                    .map_err(|_| "failed to position widget".to_string())?;
            }
        } else if position_changed || size_changed {
            if position_changed {
                window
                    .set_position(position)
                    .map_err(|_| "failed to position widget".to_string())?;
            }
            if size_changed {
                window
                    .set_size(size)
                    .map_err(|_| "failed to resize widget".to_string())?;
            }
        }
        last_applied = rect;
        if linear >= 1.0 {
            break;
        }
        {
            // Pace against an absolute deadline instead of sleeping a fixed
            // amount after each AppKit/WebView update. That keeps scheduling
            // overhead from accumulating. Windows uses a deliberately lower
            // native geometry cadence because each WebView frame change is
            // substantially more expensive there; every platform still lands
            // on the exact duration endpoint.
            let deadline = Duration::from_millis(transition_frame_deadline(
                animation_started.elapsed().as_millis() as u64,
                duration.as_millis() as u64,
                WIDGET_TRANSITION_FRAME_MS,
            ));
            if let Some(remaining) = deadline.checked_sub(animation_started.elapsed()) {
                std::thread::sleep(remaining);
            }
        }
    }
    Ok(())
}

fn expanded_position(
    collapsed: WidgetRect,
    expanded_size: PhysicalSize<u32>,
    dock: DockState,
    compact_mode: CompactMode,
    monitor: &tauri::Monitor,
    work_area: Option<WorkAreaPayload>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let (bounds_position, bounds_size) = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .unwrap_or_else(|| (*monitor.position(), *monitor.size()));
    if compact_mode == CompactMode::Island {
        return island_expanded_position_in_bounds(
            collapsed,
            expanded_size,
            bounds_position,
            bounds_size,
            safe_inset,
        );
    }
    expanded_position_in_bounds(
        collapsed,
        expanded_size,
        dock,
        bounds_position,
        bounds_size,
        safe_inset,
    )
}

fn island_expanded_position_in_bounds(
    collapsed: WidgetRect,
    expanded_size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let centered = PhysicalPosition::new(
        collapsed.position.x + (collapsed.size.width as i32 - expanded_size.width as i32) / 2,
        bounds_position.y - safe_inset,
    );
    clamp_position_to_bounds(
        centered,
        expanded_size,
        bounds_position,
        bounds_size,
        safe_inset,
    )
}

fn island_collapsed_geometry(
    current: WidgetRect,
    collapsed_size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    safe_inset: i32,
    previous: Option<WidgetGeometryState>,
) -> (WidgetRect, DockState) {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let previous_island = previous.filter(|value| value.compact_mode == CompactMode::Island);
    let x = previous_island
        .map(|value| {
            if value.user_moved_expanded {
                current.position.x + (current.size.width as i32 - collapsed_size.width as i32) / 2
            } else {
                value.collapsed_rect.position.x
            }
        })
        .unwrap_or_else(|| {
            monitor_position.x + (monitor_size.width as i32 - collapsed_size.width as i32) / 2
        });
    let position = clamp_position_to_monitor(
        PhysicalPosition::new(x, monitor_position.y - safe_inset),
        collapsed_size,
        monitor,
        safe_inset,
    );
    let dock = DockState {
        horizontal: None,
        vertical: Some(VerticalDock::Top),
    };
    (
        WidgetRect {
            position: snap_position(position, collapsed_size, dock, monitor, safe_inset),
            size: collapsed_size,
        },
        dock,
    )
}

fn collapsed_geometry_for_expand(
    current_position: PhysicalPosition<i32>,
    collapsed_size: PhysicalSize<u32>,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    threshold: i32,
    safe_inset: i32,
) -> (WidgetRect, DockState) {
    let current_collapsed = WidgetRect {
        position: clamp_position_to_bounds(
            current_position,
            collapsed_size,
            bounds_position,
            bounds_size,
            safe_inset,
        ),
        size: collapsed_size,
    };
    let dock = detect_dock_in_bounds(
        current_collapsed.position,
        collapsed_size,
        bounds_position,
        bounds_size,
        threshold,
        safe_inset,
    );
    let position = if dock.is_docked() {
        snap_position_in_bounds(
            current_collapsed.position,
            collapsed_size,
            dock,
            bounds_position,
            bounds_size,
            safe_inset,
        )
    } else {
        current_collapsed.position
    };
    (
        WidgetRect {
            position,
            size: collapsed_size,
        },
        dock,
    )
}

fn collapse_anchor(
    fallback: WidgetRect,
    compact_mode: CompactMode,
    previous: Option<WidgetGeometryState>,
) -> WidgetRect {
    previous
        .filter(|value| value.compact_mode == compact_mode)
        .map_or(fallback, |value| value.collapsed_rect)
}

fn current_widget_rect(window: &tauri::WebviewWindow) -> Result<WidgetRect, String> {
    Ok(WidgetRect {
        position: window
            .outer_position()
            .map_err(|_| "failed to read widget position".to_string())?,
        size: window
            .outer_size()
            .map_err(|_| "failed to read widget size".to_string())?,
    })
}

fn monitor_and_scale(
    window: &tauri::WebviewWindow,
) -> Result<(Option<tauri::Monitor>, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(|_| "failed to read monitor".to_string())?;
    let scale_factor = monitor
        .as_ref()
        .map(|item| item.scale_factor())
        .unwrap_or(1.0);
    Ok((monitor, scale_factor))
}

fn infer_mode(
    rect: WidgetRect,
    compact_mode: CompactMode,
    scale_factor: f64,
    safe_inset: u32,
) -> WidgetMode {
    let collapsed_size = collapsed_physical_size_with_dimensions(
        compact_mode,
        scale_factor,
        safe_inset,
        Some(CAPSULE_MAX_LOGICAL_WIDTH),
        Some(CAPSULE_MAX_LOGICAL_HEIGHT),
    );
    if rect.size.width <= collapsed_size.width + POSITION_EPSILON
        && rect.size.height <= collapsed_size.height + POSITION_EPSILON
    {
        WidgetMode::Collapsed
    } else {
        WidgetMode::Expanded
    }
}

fn infer_compact_mode(rect: WidgetRect, scale_factor: f64, safe_inset: u32) -> CompactMode {
    let island_width = widget_window_size(ISLAND_LOGICAL_WIDTH, scale_factor, safe_inset);
    if rect.size.width >= island_width.saturating_sub(POSITION_EPSILON)
        && rect.size.width > rect.size.height.saturating_mul(3)
    {
        CompactMode::Island
    } else if rect.size.width > rect.size.height.saturating_add(POSITION_EPSILON) {
        CompactMode::Capsule
    } else {
        CompactMode::Float
    }
}

fn compute_capsule_corner(
    rect: WidgetRect,
    dock: DockState,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
) -> &'static str {
    let right = match dock.horizontal {
        Some(HorizontalDock::Left) => false,
        Some(HorizontalDock::Right) => true,
        None => {
            let center_x = rect.position.x + rect.size.width as i32 / 2;
            let mid_x = bounds_position.x + bounds_size.width as i32 / 2;
            center_x >= mid_x
        }
    };
    let bottom = match dock.vertical {
        Some(VerticalDock::Top) => false,
        Some(VerticalDock::Bottom) => true,
        None => {
            let center_y = rect.position.y + rect.size.height as i32 / 2;
            let mid_y = bounds_position.y + bounds_size.height as i32 / 2;
            center_y >= mid_y
        }
    };
    match (right, bottom) {
        (true, true) => "right-bottom",
        (false, true) => "left-bottom",
        (true, false) => "right-top",
        (false, false) => "left-top",
    }
}

#[tauri::command]
fn get_widget_corner(app: AppHandle, state: State<'_, AppState>) -> Result<&'static str, String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let Some(monitor) = monitor else {
        return Ok("right-top");
    };
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor) as i32;
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let saved = state.geometry.lock().ok().and_then(|value| *value);
    let anchor = saved.map_or(current, |value| value.collapsed_rect);
    let dock = saved
        .filter(|value| value.dock.is_docked())
        .map(|value| value.dock)
        .unwrap_or_else(|| {
            detect_dock_in_bounds(
                anchor.position,
                anchor.size,
                *monitor.position(),
                *monitor.size(),
                threshold,
                safe_inset,
            )
        });
    Ok(compute_capsule_corner(
        anchor,
        dock,
        *monitor.position(),
        *monitor.size(),
    ))
}

#[tauri::command(async)]
fn snap_widget_corner_for_testing(
    corner: String,
    work_area: Option<WorkAreaPayload>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (corner, work_area, app, state);
        Err("debug_only".into())
    }
    #[cfg(debug_assertions)]
    {
        let _window_geometry_guard = state
            .window_geometry_lock
            .lock()
            .map_err(|_| "window geometry unavailable".to_string())?;
        let window = app
            .get_webview_window("widget")
            .ok_or_else(|| "widget window missing".to_string())?;
        let current = current_widget_rect(&window)?;
        let (monitor, scale_factor) = monitor_and_scale(&window)?;
        let Some(monitor) = monitor else {
            return Err("monitor unavailable".into());
        };
        let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor) as i32;
        let (bounds_position, bounds_size) = work_area
            .map(|area| {
                (
                    PhysicalPosition::new(area.position.x, area.position.y),
                    PhysicalSize::new(area.size.width, area.size.height),
                )
            })
            .unwrap_or_else(|| (*monitor.position(), *monitor.size()));
        let dock = match corner.as_str() {
            "right-bottom" => DockState {
                horizontal: Some(HorizontalDock::Right),
                vertical: Some(VerticalDock::Bottom),
            },
            "left-bottom" => DockState {
                horizontal: Some(HorizontalDock::Left),
                vertical: Some(VerticalDock::Bottom),
            },
            "right-top" => DockState {
                horizontal: Some(HorizontalDock::Right),
                vertical: Some(VerticalDock::Top),
            },
            "left-top" => DockState {
                horizontal: Some(HorizontalDock::Left),
                vertical: Some(VerticalDock::Top),
            },
            _ => return Err("invalid_corner".into()),
        };
        let position = snap_position_in_bounds(
            current.position,
            current.size,
            dock,
            bounds_position,
            bounds_size,
            safe_inset,
        );
        window
            .set_position(position)
            .map_err(|_| "failed to position widget".to_string())?;
        let collapsed_rect = WidgetRect {
            position,
            size: current.size,
        };
        if let Ok(mut geometry) = state.geometry.lock() {
            *geometry = Some(WidgetGeometryState {
                mode: WidgetMode::Collapsed,
                compact_mode: CompactMode::Capsule,
                dock,
                collapsed_rect,
                expanded_rect: None,
                user_moved_expanded: false,
            });
        }
        let resolved = compute_capsule_corner(collapsed_rect, dock, bounds_position, bounds_size);
        let _ = app.emit_to("widget", "widget-corner-changed", resolved);
        Ok(resolved.to_string())
    }
}

#[tauri::command(async)]
fn expand_widget(
    work_area: Option<WorkAreaPayload>,
    compact_layout: Option<String>,
    content_height: Option<f64>,
    compositor_motion: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WidgetMorphGeometry>, String> {
    let Some(ticket) = reserve_geometry_transition(
        &state.control_center_owner,
        &state.transition_generation,
        false,
    )?
    else {
        return Ok(None);
    };
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(None);
    }
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let compact_mode = compact_mode(compact_layout.as_deref());
    let collapsed_size = collapsed_physical_size(compact_mode, scale_factor, safe_inset);
    let bounds_height = work_area
        .map(|area| area.size.height)
        .or_else(|| monitor.as_ref().map(|item| item.size().height));
    let expanded_size = PhysicalSize::new(
        widget_window_size(EXPANDED_LOGICAL_WIDTH, scale_factor, safe_inset),
        bounded_expanded_height(
            content_height.unwrap_or(EXPANDED_LOGICAL_HEIGHT),
            scale_factor,
            safe_inset,
            bounds_height,
        ),
    );
    let Some(monitor) = monitor else {
        return finish_widget_motion(
            &window,
            current,
            WidgetRect {
                position: current.position,
                size: expanded_size,
            },
            &state.transition_generation,
            ticket,
            compositor_motion.unwrap_or(false),
            false,
        );
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let previous = state.geometry.lock().ok().and_then(|value| *value);
    let saved_compact = previous.filter(|saved| saved.compact_mode == compact_mode);
    let collapsed_size = saved_compact.map_or(collapsed_size, |saved| saved.collapsed_rect.size);
    let (bounds_position, bounds_size) = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .unwrap_or_else(|| (*monitor.position(), *monitor.size()));
    let (collapsed_rect, dock) =
        if let Some(saved) = saved_compact.filter(|_| current.size != collapsed_size) {
            // A reversal starts at the live frame, but keeps the original capsule anchor.
            (saved.collapsed_rect, saved.dock)
        } else if compact_mode == CompactMode::Island {
            island_collapsed_geometry(
                current,
                collapsed_size,
                &monitor,
                safe_inset as i32,
                previous,
            )
        } else {
            collapsed_geometry_for_expand(
                current.position,
                collapsed_size,
                bounds_position,
                bounds_size,
                threshold,
                safe_inset as i32,
            )
        };
    let expanded_rect = WidgetRect {
        position: expanded_position(
            collapsed_rect,
            expanded_size,
            dock,
            compact_mode,
            &monitor,
            work_area,
            safe_inset as i32,
        ),
        size: expanded_size,
    };

    if let Ok(mut geometry) = state.geometry.lock() {
        *geometry = Some(WidgetGeometryState {
            mode: WidgetMode::Expanded,
            compact_mode,
            dock,
            collapsed_rect,
            expanded_rect: Some(expanded_rect),
            user_moved_expanded: false,
        });
    }

    finish_widget_motion(
        &window,
        current,
        expanded_rect,
        &state.transition_generation,
        ticket,
        compositor_motion.unwrap_or(false),
        false,
    )
}

#[tauri::command(async)]
fn resize_expanded_widget(
    content_height: f64,
    keep_top: Option<bool>,
    work_area: Option<WorkAreaPayload>,
    compositor_motion: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let Some(ticket) = reserve_geometry_transition(
        &state.control_center_owner,
        &state.transition_generation,
        false,
    )?
    else {
        return Ok(());
    };
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(());
    }
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let preview_width = std::env::var_os("CODEX_COCKPIT_CONFIG_DIR")
        .map(PathBuf::from)
        .is_some_and(|path| path.is_absolute())
        .then(|| {
            std::env::var("CODEX_COCKPIT_PREVIEW_WIDTH")
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
                .map(|value| value.clamp(300.0, 700.0))
        })
        .flatten();
    let expanded_width = widget_window_size(
        preview_width.unwrap_or(EXPANDED_LOGICAL_WIDTH),
        scale_factor,
        safe_inset,
    );
    let bounds = work_area.map(|area| {
        (
            PhysicalPosition::new(area.position.x, area.position.y),
            PhysicalSize::new(area.size.width, area.size.height),
        )
    });
    let fallback_bounds = monitor
        .as_ref()
        .map(|item| (*item.position(), *item.size()));
    let active_bounds = bounds.or(fallback_bounds);
    let expanded_height = bounded_expanded_height(
        content_height,
        scale_factor,
        safe_inset,
        active_bounds.map(|(_, size)| size.height),
    );
    let expanded_size = PhysicalSize::new(expanded_width, expanded_height);
    let previous = state.geometry.lock().ok().and_then(|value| *value);

    let target = if let Some((bounds_position, bounds_size)) =
        active_bounds.filter(|_| keep_top.unwrap_or(false))
    {
        resize_from_top_in_bounds(
            current.position,
            expanded_size,
            bounds_position,
            bounds_size,
            safe_inset,
            widget_window_size(MIN_EXPANDED_LOGICAL_HEIGHT, scale_factor, safe_inset),
        )
    } else {
        let next_position = match (previous, active_bounds) {
            (Some(geometry), Some((bounds_position, bounds_size)))
                if geometry.user_moved_expanded =>
            {
                clamp_position_to_bounds(
                    current.position,
                    expanded_size,
                    bounds_position,
                    bounds_size,
                    safe_inset as i32,
                )
            }
            (Some(geometry), Some(_)) => {
                let monitor = monitor
                    .as_ref()
                    .ok_or_else(|| "widget monitor missing".to_string())?;
                expanded_position(
                    geometry.collapsed_rect,
                    expanded_size,
                    geometry.dock,
                    geometry.compact_mode,
                    monitor,
                    work_area,
                    safe_inset as i32,
                )
            }
            (_, Some((bounds_position, bounds_size))) => clamp_position_to_bounds(
                current.position,
                expanded_size,
                bounds_position,
                bounds_size,
                safe_inset as i32,
            ),
            (_, None) => current.position,
        };
        WidgetRect {
            position: next_position,
            size: expanded_size,
        }
    };
    if compositor_motion.unwrap_or(false) {
        apply_compositor_bounds(&window, target)?;
    } else {
        animate_window_to(
            &window,
            current,
            target,
            &state.transition_generation,
            ticket,
        )?;
    }

    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(());
    }
    if let (Ok(mut value), Some(mut geometry)) = (state.geometry.lock(), previous) {
        geometry.mode = WidgetMode::Expanded;
        geometry.expanded_rect = Some(target);
        *value = Some(geometry);
    }
    Ok(())
}

#[tauri::command(async)]
fn open_control_center(
    work_area: Option<WorkAreaPayload>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let Some(ticket) = reserve_geometry_transition(
        &state.control_center_owner,
        &state.transition_generation,
        true,
    )?
    else {
        return Ok(());
    };
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(());
    }
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let bounds = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .or_else(|| {
            monitor
                .as_ref()
                .map(|item| (*item.position(), *item.size()))
        });
    let mut size = PhysicalSize::new(
        widget_window_size(CONTROL_CENTER_LOGICAL_WIDTH, scale_factor, safe_inset),
        widget_window_size(CONTROL_CENTER_LOGICAL_HEIGHT, scale_factor, safe_inset),
    );
    if let Some((_, bounds_size)) = bounds {
        size.width = size.width.min(
            bounds_size
                .width
                .saturating_add(safe_inset.saturating_mul(2)),
        );
        size.height = size.height.min(
            bounds_size
                .height
                .saturating_add(safe_inset.saturating_mul(2)),
        );
    }
    let target_position = bounds
        .map(|(bounds_position, bounds_size)| {
            centered_dialog_position_in_bounds(
                size,
                bounds_position,
                bounds_size,
                safe_inset as i32,
            )
        })
        .unwrap_or(current.position);
    animate_window_to(
        &window,
        current,
        WidgetRect {
            position: target_position,
            size,
        },
        &state.transition_generation,
        ticket,
    )?;
    window
        .set_focus()
        .map_err(|_| "failed to focus control center".to_string())?;
    // On GTK, presenting the top-level window does not grab focus for its
    // WebKit child. Explicitly focus both so text fields can receive input.
    #[cfg(target_os = "linux")]
    window
        .as_ref()
        .set_focus()
        .map_err(|_| "failed to focus control center webview".to_string())?;
    Ok(())
}

#[tauri::command(async)]
fn set_control_center_calendar_open(
    open: bool,
    work_area: Option<WorkAreaPayload>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !*state
        .control_center_owner
        .lock()
        .map_err(|_| "control center ownership unavailable".to_string())?
    {
        return Ok(());
    }
    let Some(ticket) = reserve_geometry_transition(
        &state.control_center_owner,
        &state.transition_generation,
        true,
    )?
    else {
        return Ok(());
    };
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(());
    }
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let bounds = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .or_else(|| {
            monitor
                .as_ref()
                .map(|item| (*item.position(), *item.size()))
        });
    let mut size = PhysicalSize::new(
        widget_window_size(
            if open {
                CONTROL_CENTER_CALENDAR_LOGICAL_WIDTH
            } else {
                CONTROL_CENTER_LOGICAL_WIDTH
            },
            scale_factor,
            safe_inset,
        ),
        widget_window_size(CONTROL_CENTER_LOGICAL_HEIGHT, scale_factor, safe_inset),
    );
    if let Some((_, bounds_size)) = bounds {
        size.width = size.width.min(
            bounds_size
                .width
                .saturating_add(safe_inset.saturating_mul(2)),
        );
        size.height = size.height.min(
            bounds_size
                .height
                .saturating_add(safe_inset.saturating_mul(2)),
        );
    }
    let target_position = bounds
        .map(|(bounds_position, bounds_size)| {
            if open {
                clamp_position_to_bounds(
                    current.position,
                    size,
                    bounds_position,
                    bounds_size,
                    safe_inset as i32,
                )
            } else {
                centered_dialog_position_in_bounds(
                    size,
                    bounds_position,
                    bounds_size,
                    safe_inset as i32,
                )
            }
        })
        .unwrap_or(current.position);
    animate_window_to(
        &window,
        current,
        WidgetRect {
            position: target_position,
            size,
        },
        &state.transition_generation,
        ticket,
    )
}

#[tauri::command(async)]
fn close_control_center(state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    *state
        .control_center_owner
        .lock()
        .map_err(|_| "window owner unavailable".to_string())? = false;
    Ok(())
}

#[cfg(test)]
mod geometry_tests {
    #[test]
    fn dialog_ownership_blocks_stale_geometry_without_cancelling_animation() {
        let owner = std::sync::Mutex::new(false);
        let generation = std::sync::atomic::AtomicU64::new(0);
        assert_eq!(
            super::reserve_geometry_transition(&owner, &generation, false).unwrap(),
            Some(1)
        );
        assert_eq!(
            super::reserve_geometry_transition(&owner, &generation, true).unwrap(),
            Some(2)
        );
        for _ in 0..100 {
            assert_eq!(
                super::reserve_geometry_transition(&owner, &generation, false).unwrap(),
                None
            );
        }
        assert_eq!(generation.load(std::sync::atomic::Ordering::SeqCst), 2);
        *owner.lock().unwrap() = false;
        assert_eq!(
            super::reserve_geometry_transition(&owner, &generation, false).unwrap(),
            Some(3)
        );
    }
    use super::*;

    fn rect(x: i32, y: i32, size: u32) -> WidgetRect {
        WidgetRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(size, size),
        }
    }

    #[test]
    fn window_size_includes_the_transparent_safe_inset() {
        assert_eq!(window_size_for_visual_size(80, 4), 88);
        assert_eq!(widget_window_size(320.0, 1.5, 6), 492);
    }

    #[test]
    fn widget_transition_starts_gently_and_stays_symmetric() {
        let expand_steps = EXPAND_TRANSITION_MS.div_ceil(SMOOTH_TRANSITION_FRAME_MS);
        let first_expand_frame = smooth_transition_progress(1.0 / expand_steps as f64);
        assert!(first_expand_frame < 0.02);
        assert!((smooth_transition_progress(0.5) - 0.5).abs() < f64::EPSILON);
        assert!(
            (smooth_transition_progress(0.25) + smooth_transition_progress(0.75) - 1.0).abs()
                < 1e-12
        );
        assert_eq!(smooth_transition_progress(-1.0), 0.0);
        assert_eq!(smooth_transition_progress(2.0), 1.0);
    }

    #[test]
    fn windows_transition_has_a_bounded_native_frame_budget_and_exact_deadline() {
        let expand_frames = EXPAND_TRANSITION_MS.div_ceil(WINDOWS_TRANSITION_FRAME_MS);
        let collapse_frames = COLLAPSE_TRANSITION_MS.div_ceil(WINDOWS_TRANSITION_FRAME_MS);
        assert_eq!(expand_frames, 9);
        assert_eq!(collapse_frames, 7);
        assert_eq!(
            transition_frame_deadline(256, EXPAND_TRANSITION_MS, WINDOWS_TRANSITION_FRAME_MS),
            280
        );
        assert_eq!(
            transition_frame_deadline(219, COLLAPSE_TRANSITION_MS, WINDOWS_TRANSITION_FRAME_MS),
            220
        );
    }

    #[test]
    fn ten_expand_collapse_cycles_preserve_the_capsule_anchor() {
        let expand_steps = EXPAND_TRANSITION_MS.div_ceil(SMOOTH_TRANSITION_FRAME_MS) as u32;
        let collapse_steps = COLLAPSE_TRANSITION_MS.div_ceil(SMOOTH_TRANSITION_FRAME_MS) as u32;
        let collapsed = WidgetRect {
            position: PhysicalPosition::new(200, 80),
            size: PhysicalSize::new(96, 48),
        };
        let expanded = WidgetRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(528, 622),
        };

        for _ in 0..10 {
            let mut previous = collapsed;
            for step in 1..=expand_steps {
                let progress = smooth_transition_progress(step as f64 / expand_steps as f64);
                let frame = WidgetRect {
                    position: PhysicalPosition::new(
                        interpolate_i32(collapsed.position.x, expanded.position.x, progress),
                        interpolate_i32(collapsed.position.y, expanded.position.y, progress),
                    ),
                    size: PhysicalSize::new(
                        interpolate_u32(collapsed.size.width, expanded.size.width, progress),
                        interpolate_u32(collapsed.size.height, expanded.size.height, progress),
                    ),
                };
                assert!(frame.position.x <= previous.position.x);
                assert!(frame.position.y <= previous.position.y);
                assert!(frame.size.width >= previous.size.width);
                assert!(frame.size.height >= previous.size.height);
                assert!(frame.size.width > 0 && frame.size.height > 0);
                previous = frame;
            }
            assert_eq!(previous.position, expanded.position);
            assert_eq!(previous.size, expanded.size);

            for step in 1..=collapse_steps {
                let progress = smooth_transition_progress(step as f64 / collapse_steps as f64);
                let frame = WidgetRect {
                    position: PhysicalPosition::new(
                        interpolate_i32(expanded.position.x, collapsed.position.x, progress),
                        interpolate_i32(expanded.position.y, collapsed.position.y, progress),
                    ),
                    size: PhysicalSize::new(
                        interpolate_u32(expanded.size.width, collapsed.size.width, progress),
                        interpolate_u32(expanded.size.height, collapsed.size.height, progress),
                    ),
                };
                assert!(frame.position.x >= previous.position.x);
                assert!(frame.position.y >= previous.position.y);
                assert!(frame.size.width <= previous.size.width);
                assert!(frame.size.height <= previous.size.height);
                assert!(frame.size.width > 0 && frame.size.height > 0);
                previous = frame;
            }
            assert_eq!(previous.position, collapsed.position);
            assert_eq!(previous.size, collapsed.size);
        }
    }

    #[test]
    fn compact_modes_use_distinct_window_sizes() {
        assert_eq!(
            collapsed_physical_size(CompactMode::Float, 1.0, 4),
            PhysicalSize::new(100, 100)
        );
        assert_eq!(
            collapsed_physical_size(CompactMode::Capsule, 1.0, 4),
            PhysicalSize::new(96, 48)
        );
        assert_eq!(
            collapsed_physical_size_with_width(CompactMode::Capsule, 1.0, 4, Some(122.0)),
            PhysicalSize::new(130, 48)
        );
        assert_eq!(
            collapsed_physical_size(CompactMode::Island, 1.0, 4),
            PhysicalSize::new(408, 46)
        );
        assert_eq!(
            infer_compact_mode(
                WidgetRect {
                    position: PhysicalPosition::new(0, 0),
                    size: PhysicalSize::new(96, 48),
                },
                1.0,
                4
            ),
            CompactMode::Capsule
        );
        assert_eq!(
            infer_compact_mode(
                WidgetRect {
                    position: PhysicalPosition::new(0, 0),
                    size: PhysicalSize::new(408, 46),
                },
                1.0,
                4
            ),
            CompactMode::Island
        );
    }

    #[test]
    fn dual_capsule_preserves_both_readouts_at_normal_and_retina_scale() {
        for (width, scale_factor, expected_size) in [
            (228.0, 1.0, PhysicalSize::new(236, 48)),
            (320.0, 2.0, PhysicalSize::new(656, 96)),
        ] {
            let inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
            let size = collapsed_physical_size_with_width(
                CompactMode::Capsule,
                scale_factor,
                inset,
                Some(width),
            );
            assert_eq!(size, expected_size);
            let rect = WidgetRect {
                position: PhysicalPosition::new(0, 0),
                size,
            };
            assert_eq!(
                infer_compact_mode(rect, scale_factor, inset),
                CompactMode::Capsule
            );
            assert_eq!(
                infer_mode(rect, CompactMode::Capsule, scale_factor, inset),
                WidgetMode::Collapsed
            );
        }
    }

    #[test]
    fn stale_drag_completion_cannot_reposition_a_new_window_mode() {
        assert_eq!(
            drag_completion_mode(Some(WidgetMode::Collapsed), WidgetMode::Expanded),
            None
        );
        assert_eq!(
            drag_completion_mode(Some(WidgetMode::Collapsed), WidgetMode::Collapsed),
            Some(WidgetMode::Collapsed)
        );
        assert_eq!(
            drag_completion_mode(None, WidgetMode::Expanded),
            Some(WidgetMode::Expanded)
        );
    }

    #[test]
    fn collapse_returns_to_the_saved_capsule_anchor_after_expanded_drag() {
        let saved_position = PhysicalPosition::new(900, 400);
        let previous = WidgetGeometryState {
            mode: WidgetMode::Expanded,
            compact_mode: CompactMode::Capsule,
            dock: DockState::default(),
            collapsed_rect: WidgetRect {
                position: saved_position,
                size: PhysicalSize::new(96, 48),
            },
            expanded_rect: Some(WidgetRect {
                position: PhysicalPosition::new(684, 400),
                size: PhysicalSize::new(528, 648),
            }),
            user_moved_expanded: true,
        };

        let anchor = collapse_anchor(rect(120, 80, 236), CompactMode::Capsule, Some(previous));
        assert_eq!(anchor.position, previous.collapsed_rect.position);
        assert_eq!(anchor.size, previous.collapsed_rect.size);
    }

    #[test]
    fn island_expansion_stays_top_attached_and_centered() {
        let position = island_expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(756, -4),
                size: PhysicalSize::new(408, 46),
            },
            PhysicalSize::new(560, 280),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(680, -4));
    }

    #[test]
    fn undocked_expansion_is_centered_and_grows_down_from_the_compact_widget() {
        let position = expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(900, 400),
                size: PhysicalSize::new(96, 48),
            },
            PhysicalSize::new(328, 328),
            DockState::default(),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(784, 400));
    }

    #[test]
    fn expanded_height_tracks_content_and_respects_work_area() {
        assert_eq!(bounded_expanded_height(213.4, 1.0, 4, Some(1040)), 221);
        assert_eq!(bounded_expanded_height(40.0, 1.0, 4, Some(1040)), 168);
        assert_eq!(bounded_expanded_height(2_000.0, 1.0, 4, Some(700)), 708);
    }

    #[test]
    fn open_cockpit_keeps_its_header_fixed_when_tall_content_hits_the_bottom() {
        let position = PhysicalPosition::new(1440, 740);
        let bounds_position = PhysicalPosition::new(0, 20);
        let bounds_size = PhysicalSize::new(1920, 1020);
        for (requested, visible) in [(650, 304), (195, 195), (480, 304)] {
            let target = resize_from_top_in_bounds(
                position,
                PhysicalSize::new(528, requested),
                bounds_position,
                bounds_size,
                4,
                168,
            );
            assert_eq!(target.position, position);
            assert_eq!(target.size.height, visible);
        }
    }

    #[test]
    fn invalid_expanded_height_falls_back_to_the_default() {
        assert_eq!(bounded_expanded_height(f64::NAN, 1.0, 4, Some(1040)), 648);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cocoa_frame_conversion_keeps_right_and_bottom_edges_anchored() {
        let initial_frame = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(96.0, 48.0));
        let from = WidgetRect {
            position: PhysicalPosition::new(1400, 900),
            size: PhysicalSize::new(96, 48),
        };
        let to = WidgetRect {
            position: PhysicalPosition::new(968, 212),
            size: PhysicalSize::new(528, 736),
        };

        let frame = cocoa_frame_for_widget_rect(initial_frame, from, to, 1.0);

        assert_eq!(frame.origin.x + frame.size.width, 196.0);
        assert_eq!(frame.origin.y, 100.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cocoa_frame_conversion_preserves_all_four_corner_anchors() {
        let initial_frame = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(96.0, 48.0));
        let from = WidgetRect {
            position: PhysicalPosition::new(700, 400),
            size: PhysicalSize::new(96, 48),
        };
        let target_size = PhysicalSize::new(528, 628);
        let cases = [
            (PhysicalPosition::new(700, 400), (100.0, 148.0)),
            (PhysicalPosition::new(268, 400), (196.0, 148.0)),
            (PhysicalPosition::new(700, -180), (100.0, 100.0)),
            (PhysicalPosition::new(268, -180), (196.0, 100.0)),
        ];

        for (position, (anchored_x, anchored_y)) in cases {
            let frame = cocoa_frame_for_widget_rect(
                initial_frame,
                from,
                WidgetRect {
                    position,
                    size: target_size,
                },
                1.0,
            );
            let right_anchored = position.x < from.position.x;
            let bottom_anchored = position.y < from.position.y;
            let actual_x = if right_anchored {
                frame.origin.x + frame.size.width
            } else {
                frame.origin.x
            };
            let actual_y = if bottom_anchored {
                frame.origin.y
            } else {
                frame.origin.y + frame.size.height
            };
            assert_eq!(actual_x, anchored_x);
            assert_eq!(actual_y, anchored_y);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pinned_macos_widget_uses_focus_neutral_cross_space_policy() {
        let policy = macos_window_presence_policy(true);

        assert_eq!(policy.level, NSStatusWindowLevel);
        assert!(policy
            .collection_behavior
            .contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(policy
            .collection_behavior
            .contains(NSWindowCollectionBehavior::Stationary));
        assert!(policy
            .collection_behavior
            .contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(!policy.hides_on_deactivate);
        assert!(!policy.can_hide);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unpinned_macos_widget_returns_to_normal_space_policy() {
        let policy = macos_window_presence_policy(false);

        assert_eq!(policy.level, NSNormalWindowLevel);
        assert_eq!(
            policy.collection_behavior,
            NSWindowCollectionBehavior::Default
        );
        assert!(!policy.hides_on_deactivate);
        assert!(!policy.can_hide);
    }

    #[test]
    fn control_center_is_centered_in_the_active_work_area() {
        let position = centered_dialog_position_in_bounds(
            PhysicalSize::new(728, 688),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(596, 176));
    }

    #[test]
    fn expansion_stays_above_a_bottom_taskbar() {
        let position = expanded_position_in_bounds(
            rect(1812, 952, 88),
            PhysicalSize::new(328, 328),
            DockState {
                horizontal: Some(HorizontalDock::Right),
                vertical: Some(VerticalDock::Bottom),
            },
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(1572, 712));
    }

    #[test]
    fn capsule_at_each_screen_edge_expands_toward_the_interior() {
        let bounds_position = PhysicalPosition::new(0, 0);
        let bounds_size = PhysicalSize::new(1920, 1040);
        let expanded_size = PhysicalSize::new(328, 328);
        let capsule_size = PhysicalSize::new(96, 48);

        let at_left = expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(-4, 400),
                size: capsule_size,
            },
            expanded_size,
            DockState {
                horizontal: Some(HorizontalDock::Left),
                vertical: None,
            },
            bounds_position,
            bounds_size,
            4,
        );
        let at_right = expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(1828, 400),
                size: capsule_size,
            },
            expanded_size,
            DockState {
                horizontal: Some(HorizontalDock::Right),
                vertical: None,
            },
            bounds_position,
            bounds_size,
            4,
        );
        let at_top = expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(900, -4),
                size: capsule_size,
            },
            expanded_size,
            DockState {
                horizontal: None,
                vertical: Some(VerticalDock::Top),
            },
            bounds_position,
            bounds_size,
            4,
        );
        let at_bottom = expanded_position_in_bounds(
            WidgetRect {
                position: PhysicalPosition::new(900, 996),
                size: capsule_size,
            },
            expanded_size,
            DockState {
                horizontal: None,
                vertical: Some(VerticalDock::Bottom),
            },
            bounds_position,
            bounds_size,
            4,
        );

        assert_eq!(at_left, PhysicalPosition::new(-4, 400));
        assert_eq!(at_right, PhysicalPosition::new(1596, 400));
        assert_eq!(at_top, PhysicalPosition::new(784, -4));
        assert_eq!(at_bottom, PhysicalPosition::new(784, 716));
    }

    #[test]
    fn dragged_capsule_uses_each_work_area_corner_as_its_live_anchor() {
        let bounds_position = PhysicalPosition::new(0, 25);
        let bounds_size = PhysicalSize::new(1512, 815);
        let capsule_size = PhysicalSize::new(96, 48);
        let expanded_size = PhysicalSize::new(528, 628);
        let cases = [
            (
                PhysicalPosition::new(-4, 21),
                DockState {
                    horizontal: Some(HorizontalDock::Left),
                    vertical: Some(VerticalDock::Top),
                },
                PhysicalPosition::new(-4, 21),
            ),
            (
                PhysicalPosition::new(1420, 21),
                DockState {
                    horizontal: Some(HorizontalDock::Right),
                    vertical: Some(VerticalDock::Top),
                },
                PhysicalPosition::new(988, 21),
            ),
            (
                PhysicalPosition::new(-4, 796),
                DockState {
                    horizontal: Some(HorizontalDock::Left),
                    vertical: Some(VerticalDock::Bottom),
                },
                PhysicalPosition::new(-4, 216),
            ),
            (
                PhysicalPosition::new(1420, 796),
                DockState {
                    horizontal: Some(HorizontalDock::Right),
                    vertical: Some(VerticalDock::Bottom),
                },
                PhysicalPosition::new(988, 216),
            ),
        ];

        for (capsule_position, expected_dock, expected_expanded_position) in cases {
            let (collapsed, dock) = collapsed_geometry_for_expand(
                capsule_position,
                capsule_size,
                bounds_position,
                bounds_size,
                24,
                4,
            );
            assert_eq!(collapsed.position, capsule_position);
            assert_eq!(dock, expected_dock);
            assert_eq!(
                expanded_position_in_bounds(
                    collapsed,
                    expanded_size,
                    dock,
                    bounds_position,
                    bounds_size,
                    4,
                ),
                expected_expanded_position,
            );
        }
    }

    #[test]
    fn expansion_handles_negative_origin_work_areas() {
        let position = expanded_position_in_bounds(
            rect(-1284, -4, 88),
            PhysicalSize::new(328, 328),
            DockState {
                horizontal: Some(HorizontalDock::Left),
                vertical: Some(VerticalDock::Top),
            },
            PhysicalPosition::new(-1280, 0),
            PhysicalSize::new(1280, 984),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(-1284, -4));
    }

    #[test]
    fn undocked_expansion_clamps_inward_only_when_the_work_area_requires_it() {
        let position = expanded_position_in_bounds(
            rect(1750, 900, 88),
            PhysicalSize::new(328, 328),
            DockState::default(),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(1596, 716));
    }

    #[test]
    fn double_row_capsules_and_all_four_corners_resolve_cleanly() {
        let inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, 2.0);
        let size = collapsed_physical_size_with_dimensions(
            CompactMode::Capsule,
            2.0,
            inset,
            Some(148.0),
            Some(79.0),
        );
        assert_eq!(size, PhysicalSize::new(312, 174));
        let sample = WidgetRect {
            position: PhysicalPosition::new(0, 0),
            size,
        };
        assert_eq!(infer_compact_mode(sample, 2.0, inset), CompactMode::Capsule);
        assert_eq!(
            infer_mode(sample, CompactMode::Capsule, 2.0, inset),
            WidgetMode::Collapsed
        );

        let origin = PhysicalPosition::new(0, 25);
        let bounds = PhysicalSize::new(1512, 815);
        for (x, y, dock, expected) in [
            (
                1400,
                750,
                DockState {
                    horizontal: Some(HorizontalDock::Right),
                    vertical: Some(VerticalDock::Bottom),
                },
                "right-bottom",
            ),
            (
                0,
                750,
                DockState {
                    horizontal: Some(HorizontalDock::Left),
                    vertical: Some(VerticalDock::Bottom),
                },
                "left-bottom",
            ),
            (
                1400,
                25,
                DockState {
                    horizontal: Some(HorizontalDock::Right),
                    vertical: Some(VerticalDock::Top),
                },
                "right-top",
            ),
            (
                0,
                25,
                DockState {
                    horizontal: Some(HorizontalDock::Left),
                    vertical: Some(VerticalDock::Top),
                },
                "left-top",
            ),
        ] {
            let corner_rect = WidgetRect {
                position: PhysicalPosition::new(x, y),
                size: PhysicalSize::new(200, 160),
            };
            assert_eq!(
                compute_capsule_corner(corner_rect, dock, origin, bounds),
                expected
            );
            assert_eq!(
                compute_capsule_corner(corner_rect, DockState::default(), origin, bounds),
                expected
            );
        }
    }
}

#[tauri::command(async)]
fn collapse_widget(
    compact_layout: Option<String>,
    compact_width: Option<f64>,
    compact_height: Option<f64>,
    compositor_motion: Option<bool>,
    preview: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<WidgetMorphGeometry>, String> {
    let Some(ticket) = reserve_geometry_transition(
        &state.control_center_owner,
        &state.transition_generation,
        false,
    )?
    else {
        return Ok(None);
    };
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    if state.transition_generation.load(Ordering::SeqCst) != ticket {
        return Ok(None);
    }
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let compact_mode = compact_mode(compact_layout.as_deref());
    let collapsed_size = collapsed_physical_size_with_dimensions(
        compact_mode,
        scale_factor,
        safe_inset,
        compact_width,
        compact_height,
    );
    let Some(monitor) = monitor else {
        return finish_widget_motion(
            &window,
            current,
            WidgetRect {
                position: current.position,
                size: collapsed_size,
            },
            &state.transition_generation,
            ticket,
            compositor_motion.unwrap_or(false),
            preview.unwrap_or(false),
        );
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let previous = state.geometry.lock().ok().and_then(|value| *value);
    let (collapsed_rect, dock) = if compact_mode == CompactMode::Island {
        island_collapsed_geometry(
            current,
            collapsed_size,
            &monitor,
            safe_inset as i32,
            previous,
        )
    } else {
        // The compact widget owns its anchor. Moving or interacting with the
        // expanded panel must never relocate the capsule when it collapses.
        let anchor = collapse_anchor(
            WidgetRect {
                position: current.position,
                size: collapsed_size,
            },
            compact_mode,
            previous,
        );
        // Find the dock from the previous footprint so a change in width
        // does not detach a capsule that was against the right edge.
        let dock = detect_dock(
            anchor.position,
            anchor.size,
            &monitor,
            threshold,
            safe_inset as i32,
        );
        let next_position = if dock.is_docked() {
            snap_position(
                anchor.position,
                collapsed_size,
                dock,
                &monitor,
                safe_inset as i32,
            )
        } else {
            clamp_position_to_monitor(anchor.position, collapsed_size, &monitor, safe_inset as i32)
        };
        (
            WidgetRect {
                position: next_position,
                size: collapsed_size,
            },
            dock,
        )
    };
    if preview.unwrap_or(false) {
        return finish_widget_motion(
            &window,
            current,
            collapsed_rect,
            &state.transition_generation,
            ticket,
            false,
            true,
        );
    }
    if let Ok(mut geometry) = state.geometry.lock() {
        *geometry = Some(WidgetGeometryState {
            mode: WidgetMode::Collapsed,
            compact_mode,
            dock,
            collapsed_rect,
            expanded_rect: None,
            user_moved_expanded: false,
        });
    }
    let corner = compute_capsule_corner(collapsed_rect, dock, *monitor.position(), *monitor.size());
    let _ = app.emit_to("widget", "widget-corner-changed", corner);
    finish_widget_motion(
        &window,
        current,
        WidgetRect {
            position: collapsed_rect.position,
            size: collapsed_size,
        },
        &state.transition_generation,
        ticket,
        compositor_motion.unwrap_or(false),
        false,
    )
}

#[tauri::command(async)]
fn begin_widget_drag(
    pointer_driven: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Finish the active shape transition before handing the frame to a drag.
    // Cancelling here would leave a mid-sized window with a settled React surface.
    let window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let cached_mode = state
        .geometry
        .lock()
        .ok()
        .and_then(|value| *value)
        .map(|value| value.mode);
    let mode = if let Some(mode) = cached_mode {
        mode
    } else {
        let current = current_widget_rect(&window)?;
        let (_, scale_factor) = monitor_and_scale(&window)?;
        let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
        let compact_mode = infer_compact_mode(current, scale_factor, safe_inset);
        infer_mode(current, compact_mode, scale_factor, safe_inset)
    };
    #[cfg(target_os = "macos")]
    if pointer_driven.unwrap_or(false) {
        let frame = read_macos_window_frame(&window)?;
        *state
            .drag_origin
            .lock()
            .map_err(|_| "widget drag unavailable")? = Some(frame);
    }
    if let Ok(mut drag_mode) = state.drag_mode.lock() {
        *drag_mode = Some(mode);
    }
    drop(window_geometry_guard);
    if pointer_driven.unwrap_or(false) {
        return Ok(());
    }
    if let Err(error) = window.start_dragging() {
        if let Ok(mut drag_mode) = state.drag_mode.lock() {
            *drag_mode = None;
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command(async)]
fn move_widget_drag(
    dx: f64,
    dy: f64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let origin = *state
            .drag_origin
            .lock()
            .map_err(|_| "widget drag unavailable")?;
        let Some(mut frame) = origin else {
            return Ok(());
        };
        if !dx.is_finite() || !dy.is_finite() {
            return Err("invalid widget drag position".into());
        }
        frame.origin.x += dx;
        frame.origin.y -= dy;
        let window = app
            .get_webview_window("widget")
            .ok_or("widget window missing")?;
        set_macos_window_frame(&window, frame)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (dx, dy, app, state);
    Ok(())
}

#[tauri::command]
fn is_widget_drag_button_pressed() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2_app_kit::NSEvent::pressedMouseButtons() & 1 != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command(async)]
fn finish_widget_drag(
    work_area: Option<WorkAreaPayload>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _window_geometry_guard = state
        .window_geometry_lock
        .lock()
        .map_err(|_| "window geometry unavailable".to_string())?;
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    #[cfg(target_os = "macos")]
    if let Ok(mut origin) = state.drag_origin.lock() {
        *origin = None;
    }
    let current = current_widget_rect(&window)?;
    let started_mode = state
        .drag_mode
        .lock()
        .ok()
        .and_then(|mut value| value.take());
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let (bounds_position, bounds_size) = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .unwrap_or_else(|| (*monitor.position(), *monitor.size()));
    let previous_geometry = state.geometry.lock().ok().and_then(|value| *value);
    let compact_mode = previous_geometry
        .map(|value| value.compact_mode)
        .unwrap_or_else(|| infer_compact_mode(current, scale_factor, safe_inset));
    let current_mode = previous_geometry
        .map(|value| value.mode)
        .unwrap_or_else(|| infer_mode(current, compact_mode, scale_factor, safe_inset));
    let Some(mode) = drag_completion_mode(started_mode, current_mode) else {
        return Ok(());
    };

    match mode {
        WidgetMode::Collapsed => {
            let collapsed_size = current.size;
            let (collapsed_rect, dock) = if compact_mode == CompactMode::Island {
                island_collapsed_geometry(
                    current,
                    collapsed_size,
                    &monitor,
                    safe_inset as i32,
                    previous_geometry,
                )
            } else {
                let dock = detect_dock_in_bounds(
                    current.position,
                    collapsed_size,
                    bounds_position,
                    bounds_size,
                    threshold,
                    safe_inset as i32,
                );
                let position = if dock.is_docked() {
                    snap_position_in_bounds(
                        current.position,
                        collapsed_size,
                        dock,
                        bounds_position,
                        bounds_size,
                        safe_inset as i32,
                    )
                } else {
                    clamp_position_to_bounds(
                        current.position,
                        collapsed_size,
                        bounds_position,
                        bounds_size,
                        safe_inset as i32,
                    )
                };
                (
                    WidgetRect {
                        position,
                        size: collapsed_size,
                    },
                    dock,
                )
            };
            if collapsed_rect.position != current.position {
                window
                    .set_position(collapsed_rect.position)
                    .map_err(|_| "failed to position widget".to_string())?;
            }
            if let Ok(mut geometry) = state.geometry.lock() {
                *geometry = Some(WidgetGeometryState {
                    mode: WidgetMode::Collapsed,
                    compact_mode,
                    dock,
                    collapsed_rect,
                    expanded_rect: None,
                    user_moved_expanded: false,
                });
            }
            let corner = compute_capsule_corner(collapsed_rect, dock, bounds_position, bounds_size);
            let _ = app.emit_to("widget", "widget-corner-changed", corner);
        }
        WidgetMode::Expanded => {
            let current_position = clamp_position_to_bounds(
                current.position,
                current.size,
                bounds_position,
                bounds_size,
                safe_inset as i32,
            );
            let updated_rect = WidgetRect {
                position: current_position,
                size: current.size,
            };
            window
                .set_position(current_position)
                .map_err(|_| "failed to position widget".to_string())?;
            if let Ok(mut geometry) = state.geometry.lock() {
                if let Some(mut value) = *geometry {
                    value.mode = WidgetMode::Expanded;
                    value.expanded_rect = Some(updated_rect);
                    value.user_moved_expanded = true;
                    *geometry = Some(value);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<WidgetPreferences, String> {
    state
        .preferences
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "settings unavailable".into())
}

#[tauri::command]
fn set_preferences(
    preferences: WidgetPreferences,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let preferences = preferences.normalized();
    persist_preferences(&state.preferences_path, &preferences)?;
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = preferences;
    Ok(())
}

#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("failed to read autostart state: {error}"))
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool, app: AppHandle) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|error| format!("failed to update autostart state: {error}"))?;
    manager
        .is_enabled()
        .map_err(|error| format!("failed to confirm autostart state: {error}"))
}

fn apply_lock(app: &AppHandle, locked: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    window
        .set_ignore_cursor_events(locked)
        .map_err(|_| "failed to toggle click-through".to_string())
}

#[tauri::command]
fn set_widget_locked(
    locked: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let previous = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    let mut next = previous.clone();
    next.locked = locked;
    persist_preferences(&state.preferences_path, &next)?;
    if let Err(error) = apply_lock(&app, locked) {
        let _ = persist_preferences(&state.preferences_path, &previous);
        return Err(error);
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    Ok(next)
}

#[tauri::command]
fn set_widget_always_on_top(
    always_on_top: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let previous = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    let mut next = previous.clone();
    next.always_on_top = always_on_top;
    persist_preferences(&state.preferences_path, &next)?;
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    if let Err(error) = apply_widget_window_presence(&window, always_on_top) {
        let _ = persist_preferences(&state.preferences_path, &previous);
        return Err(error);
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    let _ = app.emit_to("widget", "preferences-changed", next.clone());
    Ok(next)
}

// macOS uses a template foreground; Windows and Linux need a visible color on taskbar/panel themes.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn quota_tray_ring(remaining: Option<f64>) -> tauri::image::Image<'static> {
    let size = 36usize;
    let mut rgba = vec![0u8; size * size * 4];
    let fraction = remaining.unwrap_or(0.0).clamp(0.0, 100.0) / 100.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f64 + 0.5 - 18.0;
            let dy = y as f64 + 0.5 - 18.0;
            let radius = dx.hypot(dy);
            let coverage = (1.0 - ((radius - 13.5).abs() - 1.0).max(0.0)).clamp(0.0, 1.0);
            let angle = (dx.atan2(-dy) + std::f64::consts::TAU) % std::f64::consts::TAU;
            let alpha = coverage
                * if angle < fraction * std::f64::consts::TAU {
                    255.0
                } else {
                    65.0
                };
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            rgba[(y * size + x) * 4..(y * size + x) * 4 + 3].copy_from_slice(&[57, 122, 224]);
            rgba[(y * size + x) * 4 + 3] = alpha as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, size as u32, size as u32)
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let usage = MenuItem::with_id(app, "usage", "Usage", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show / Hide Widget", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let unlock = MenuItem::with_id(app, "unlock", "Unlock widget", true, None::<&str>)?;
    let pin = MenuItem::with_id(app, "pin", "Toggle Codex Pin", true, None::<&str>)?;
    let language = MenuItem::with_id(app, "language", "切换到中文", true, None::<&str>)?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    #[cfg(debug_assertions)]
    let test_short_window = CheckMenuItem::with_id(
        app,
        "debug-short-window",
        "Test: simulate 5-hour quota",
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Codex Cockpit", true, None::<&str>)?;
    let widget = Submenu::with_items(app, "Floating Widget", true, &[&show, &unlock, &pin])?;
    let more = Submenu::with_items(app, "More", true, &[&update, &autostart, &language])?;
    let initial_language = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .preferences
                .lock()
                .ok()
                .map(|prefs| prefs.language.clone())
        })
        .unwrap_or_else(|| "zh-CN".into());
    if initial_language != "en" {
        let _ = usage.set_text("用量统计");
        let _ = settings.set_text("设置");
        let _ = widget.set_text("悬浮窗");
        let _ = more.set_text("更多");
        let _ = show.set_text("显示 / 隐藏悬浮窗");
        let _ = refresh.set_text("立即刷新");
        let _ = update.set_text("检查更新");
        let _ = unlock.set_text("解锁悬浮窗");
        let _ = pin.set_text("切换 Codex 固定状态");
        let _ = language.set_text("Switch to English");
        let _ = autostart.set_text("开机启动");
        let _ = quit.set_text("退出驾驶舱");
    }
    let top_separator = PredefinedMenuItem::separator(app)?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    let items: &[&dyn IsMenuItem<_>] = &[
        &usage,
        &settings,
        &refresh,
        &top_separator,
        &widget,
        &more,
        #[cfg(debug_assertions)]
        &test_short_window,
        &quit_separator,
        &quit,
    ];
    let menu = Menu::with_items(app, items)?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Codex 驾驶舱");
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(quota_tray_ring(None))
            .icon_as_template(true)
            .title("—");
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    #[cfg(target_os = "linux")]
    {
        builder = builder.title("—");
    }
    let autostart_menu = autostart.clone();
    let show_menu = show.clone();
    let refresh_menu = refresh.clone();
    let update_menu = update.clone();
    let unlock_menu = unlock.clone();
    let pin_menu = pin.clone();
    let language_menu = language.clone();
    let quit_menu = quit.clone();
    #[cfg(debug_assertions)]
    let test_short_window_menu = test_short_window.clone();
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            page @ ("usage" | "settings") => {
                if let Some(window) = app.get_webview_window("widget") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit_to("widget", "control-center-requested", page);
                }
            }
            "show" => {
                if let Some(window) = app.get_webview_window("widget") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "refresh" => {
                let _ = app.emit_to("widget", "refresh-requested", true);
            }
            "update" => {
                let _ = app.emit_to("widget", "update-check-requested", ());
            }
            "debug-short-window" =>
            {
                #[cfg(debug_assertions)]
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut enabled) = state.simulate_short_window_for_testing.lock() {
                        *enabled = !*enabled;
                        let _ = test_short_window_menu.set_checked(*enabled);
                        let _ = app.emit_to("widget", "refresh-requested", ());
                    }
                }
            }
            "unlock" => {
                let _ = apply_lock(app, false);
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.locked = false;
                        let _ = persist_preferences(&state.preferences_path, &prefs);
                        let _ = app.emit_to("widget", "preferences-changed", prefs.clone());
                    }
                }
            }
            "pin" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.pinned_provider = if prefs.pinned_provider.is_some() {
                            None
                        } else {
                            Some("codex".into())
                        };
                        let _ = persist_preferences(&state.preferences_path, &prefs);
                        let _ = app.emit_to("widget", "preferences-changed", prefs.clone());
                    }
                }
            }
            "language" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.language = if prefs.language == "en" {
                            "zh-CN".into()
                        } else {
                            "en".into()
                        };
                        let normalized = prefs.clone().normalized();
                        *prefs = normalized.clone();
                        let _ = persist_preferences(&state.preferences_path, &normalized);
                        let english = normalized.language == "en";
                        let _ = usage.set_text(if english { "Usage" } else { "用量统计" });
                        let _ = settings.set_text(if english { "Settings" } else { "设置" });
                        let _ = widget.set_text(if english {
                            "Floating Widget"
                        } else {
                            "悬浮窗"
                        });
                        let _ = more.set_text(if english { "More" } else { "更多" });
                        let _ = show_menu.set_text(if english {
                            "Show / Hide Widget"
                        } else {
                            "显示 / 隐藏悬浮窗"
                        });
                        let _ = refresh_menu.set_text(if english {
                            "Refresh now"
                        } else {
                            "立即刷新"
                        });
                        let _ = update_menu.set_text(if english {
                            "Check for updates"
                        } else {
                            "检查更新"
                        });
                        let _ = unlock_menu.set_text(if english {
                            "Unlock widget"
                        } else {
                            "解锁悬浮窗"
                        });
                        let _ = pin_menu.set_text(if english {
                            "Toggle Codex Pin"
                        } else {
                            "切换 Codex 固定状态"
                        });
                        let _ = language_menu.set_text(if english {
                            "切换到中文"
                        } else {
                            "Switch to English"
                        });
                        let _ = autostart_menu.set_text(if english {
                            "Start at login"
                        } else {
                            "开机启动"
                        });
                        let _ = quit_menu.set_text(if english {
                            "Quit Codex Cockpit"
                        } else {
                            "退出驾驶舱"
                        });
                        let _ = app.emit_to("widget", "preferences-changed", normalized);
                    }
                }
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_menu.set_checked(!enabled);
                    }
                    Err(_) => eprintln!("autostart update failed"),
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let isolated_profile = std::env::var_os("CODEX_COCKPIT_CONFIG_DIR")
        .map(PathBuf::from)
        .is_some_and(|path| path.is_absolute());
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ));
    if !isolated_profile {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app.get_webview_window("widget") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(WindowStateBuilder::default().build());
    }
    let app = builder
        .setup(move |app| {
            let data_dir = app_config_dir(app.handle())?;
            // Local statistics never require joining a cloud space first.
            let _ = local_usage::initialize(&data_dir);
            let preferences_path = data_dir.join("preferences.json");
            let runtime_state_path = data_dir.join("runtime-state.json");
            let preferences = load_preferences(&preferences_path);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("QuotaFloat/0.1")
                .build()
                .expect("static HTTP client configuration must be valid");
            app.manage(AppState {
                client,
                preferences: Mutex::new(preferences.clone()),
                preferences_path,
                runtime_state_path,
                fetch_lock: tokio::sync::Mutex::new(()),
                snapshot_cache: Mutex::new(None),
                #[cfg(debug_assertions)]
                simulate_short_window_for_testing: Mutex::new(false),
                window_geometry_lock: Mutex::new(()),
                transition_generation: AtomicU64::new(0),
                #[cfg(target_os = "windows")]
                frame_mask: Mutex::new(None),
                control_center_owner: Mutex::new(false),
                geometry: Mutex::new(None),
                drag_mode: Mutex::new(None),
                #[cfg(target_os = "macos")]
                drag_origin: Mutex::new(None),
            });
            usage_sync::start(app.handle().clone());
            if setup_tray(app).is_err() {
                eprintln!("tray setup failed; enabling taskbar fallback");
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                if let Some(window) = app.get_webview_window("widget") {
                    let _ = window.set_skip_taskbar(false);
                }
            } else {
                // LSUIElement covers bundle launch; set the runtime policy as well
                // so Tauri keeps the menu-bar utility out of the macOS Dock.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            if preferences.locked {
                let _ = apply_lock(app.handle(), true);
            }
            if let Some(window) = app.get_webview_window("widget") {
                #[cfg(target_os = "linux")]
                {
                    use gtk::prelude::*;
                    linux_window::install(&window.gtk_window()?);
                    let presence_handle = app.handle().clone();
                    window.gtk_window()?.connect_map(move |gtk_window| {
                        let always_on_top = presence_handle
                            .state::<AppState>()
                            .preferences
                            .lock()
                            .map(|preferences| preferences.always_on_top)
                            .unwrap_or(true);
                        if let Some(surface) = gtk_window.window() {
                            surface.set_keep_above(always_on_top);
                        }
                    });
                }
                if let Err(error) = apply_widget_window_presence(&window, preferences.always_on_top)
                {
                    eprintln!("widget presence policy failed: {error}");
                }
            }
            let presence_handle = app.handle().clone();
            let initial_always_on_top = preferences.always_on_top;
            let preview_corner = isolated_profile
                .then(|| std::env::var("CODEX_COCKPIT_PREVIEW_CORNER").ok())
                .flatten();
            let preview_expanded = isolated_profile
                && std::env::var("CODEX_COCKPIT_PREVIEW_EXPANDED")
                    .ok()
                    .is_some_and(|v| v == "1");
            let preview_width = isolated_profile
                .then(|| {
                    std::env::var("CODEX_COCKPIT_PREVIEW_WIDTH")
                        .ok()
                        .and_then(|v| v.parse::<f64>().ok())
                })
                .flatten();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if let Some(window) = presence_handle.get_webview_window("widget") {
                    if let Err(error) = apply_widget_window_presence(&window, initial_always_on_top)
                    {
                        eprintln!("deferred widget presence policy failed: {error}");
                    }
                    if preview_expanded {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                        let (_, scale_factor) = monitor_and_scale(&window).unwrap_or((None, 2.0));
                        let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
                        let width = preview_width
                            .unwrap_or(EXPANDED_LOGICAL_WIDTH)
                            .clamp(300.0, 700.0);
                        let size = PhysicalSize::new(
                            widget_window_size(width, scale_factor, safe_inset),
                            widget_window_size(640.0, scale_factor, safe_inset),
                        );
                        let _ = window.set_size(size);
                        if let Ok((Some(monitor), _)) = monitor_and_scale(&window) {
                            let pos = centered_dialog_position_in_bounds(
                                size,
                                *monitor.position(),
                                *monitor.size(),
                                safe_inset as i32,
                            );
                            let _ = window.set_position(pos);
                        }
                        let _ = presence_handle.emit_to("widget", "preview-expand", ());
                    } else if let Some(corner) = preview_corner {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                        if let Some(state) = presence_handle.try_state::<AppState>() {
                            let _ = snap_widget_corner_for_testing(
                                corner,
                                None,
                                presence_handle.clone(),
                                state,
                            );
                        }
                    }
                }
            });
            let background_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                run_background_refresh_loop(background_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_icon::set_app_icon_theme,
            set_capsule_glass,
            local_usage::get_local_usage_source,
            local_usage::save_local_usage_source,
            app_updater::check_cockpit_update,
            tokei_usage::get_tokei_usage,
            usage_sync::get_usage_sync_status,
            cloud_sync::get_cloud_sync_status,
            cloud_sync::get_shared_claude_quota,
            cloud_sync::get_shared_gemini_quota,
            provider_usage_sync::get_shared_provider_usage,
            cloud_sync::connect_cloud_sync,
            cloud_sync::create_cloud_invite,
            cloud_sync::revoke_cloud_device,
            cloud_sync::set_cloud_sync_enabled,
            cloud_sync::set_cloud_task_sharing,
            usage_sync::save_usage_sync_settings,
            usage_sync::sync_usage_now,
            usage_sync::get_codex_project_usage,
            usage_sync::get_synced_comfort_feedback,
            shared_settings::get_person_plan,
            shared_settings::save_person_plan,
            cloud_sync::exchange_daily_plan,
            tokei_usage::get_tokei_groups,
            tokei_usage::save_tokei_groups,
            get_snapshots,
            refresh_snapshots,
            get_codex_reset_forecast,
            get_codex_website_reset_probability,
            get_codex_daily_usage,
            get_codex_daily_usage_history,
            get_claude_usage,
            get_claude_quota,
            login_claude_code,
            get_claude_reset_forecast,
            get_gemini_quota,
            quota_tray::set_menu_bar_quotas,
            get_gemini_usage,
            report_preview_metrics,
            get_volcengine_diagnostics,
            reconnect_volcengine,
            expand_widget,
            reveal_widget_frame,
            resize_expanded_widget,
            open_control_center,
            set_control_center_calendar_open,
            close_control_center,
            collapse_widget,
            get_widget_corner,
            snap_widget_corner_for_testing,
            begin_widget_drag,
            move_widget_drag,
            is_widget_drag_button_pressed,
            finish_widget_drag,
            get_preferences,
            set_preferences,
            get_autostart_enabled,
            set_autostart_enabled,
            set_widget_locked,
            set_widget_always_on_top,
            get_runtime_state,
            set_runtime_state,
            export_app_data,
            import_app_data,
            create_automatic_backup,
            restore_latest_backup,
            get_app_diagnostics
        ])
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("widget") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Codex 驾驶舱");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Resumed) {
            let _ = app_handle.emit_to("widget", "refresh-requested", ());
            if let Some(window) = app_handle.get_webview_window("widget") {
                let always_on_top = app_handle
                    .state::<AppState>()
                    .preferences
                    .lock()
                    .map(|preferences| preferences.always_on_top)
                    .unwrap_or(true);
                let _ = apply_widget_window_presence(&window, always_on_top);
            }
        }
    });
}

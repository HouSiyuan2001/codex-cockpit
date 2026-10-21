//! Application-local compatibility for GTK running through X11/XWayland.

use std::{env, fs};

#[link(name = "X11")]
unsafe extern "C" {
    fn XInitThreads() -> std::ffi::c_int;
}

fn initialize_xlib_threads_with(
    initialize: impl FnOnce() -> std::ffi::c_int,
) -> Result<(), &'static str> {
    if initialize() == 0 {
        Err("Unable to initialize X11 thread support; the application cannot start safely.")
    } else {
        Ok(())
    }
}

pub fn configure() -> Result<(), &'static str> {
    // Xlib requires this before any GTK/WebKit display access. In particular,
    // the software-rendered X11 path can access Xlib from more than one thread.
    // SAFETY: main calls configure before starting Tauri/GTK or worker threads;
    // XInitThreads has no arguments and does not open a display connection.
    initialize_xlib_threads_with(|| unsafe { XInitThreads() })?;
    if should_default_to_x11(
        env::var_os("GDK_BACKEND").as_deref(),
        env::var_os("DISPLAY").as_deref(),
    ) {
        env::set_var("GDK_BACKEND", "x11");
    }
    if env::var("GDK_BACKEND").as_deref() != Ok("x11") {
        return Ok(());
    }
    configure_x11_input_method();
    // Apply only to our X11 process, before GTK/WebKit initialize. Keep
    // explicit launcher overrides and native Wayland's renderer untouched.
    for name in [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        if env::var_os(name).is_none() {
            env::set_var(name, "1");
        }
    }
    Ok(())
}

fn should_default_to_x11(
    backend: Option<&std::ffi::OsStr>,
    display: Option<&std::ffi::OsStr>,
) -> bool {
    backend.is_none() && display.is_some_and(|value| !value.is_empty())
}

fn configure_x11_input_method() {
    let explicit_module = env::var_os("GTK_IM_MODULE").is_some();
    let backend = env::var("GDK_BACKEND").unwrap_or_default();
    if explicit_module || backend != "x11" {
        return;
    }
    let input_config = dirs::home_dir()
        .and_then(|home| fs::read_to_string(home.join(".xinputrc")).ok())
        .unwrap_or_default();
    let gtk_settings = dirs::config_dir()
        .and_then(|config| fs::read_to_string(config.join("gtk-3.0/settings.ini")).ok())
        .unwrap_or_default();
    if let Some(module) =
        gtk_input_method_fallback(explicit_module, &backend, &gtk_settings, &input_config)
    {
        // GTK's locale-based XIM fallback can stop editable fields updating
        // in a transparent WebKit window. Honor the user's selected framework
        // with its GTK module before GTK/WebKit initialize. No config is written.
        env::set_var("GTK_IM_MODULE", module);
    }
}

fn gtk_input_method_fallback(
    explicit_module: bool,
    backend: &str,
    gtk_settings: &str,
    input_config: &str,
) -> Option<&'static str> {
    if explicit_module || backend != "x11" || has_explicit_gtk_module(gtk_settings) {
        return None;
    }
    let mut selected_fcitx = false;
    for line in input_config.lines() {
        let mut words = line
            .split_whitespace()
            .take_while(|word| !word.starts_with('#'));
        let Some(command) = words.next() else {
            continue;
        };
        // im-config writes a single framework selection. Ambiguous/custom
        // shell expressions are left to GTK; this file is never executed.
        if command != "run_im" || selected_fcitx {
            return None;
        }
        let selected = matches!(
            words.next(),
            Some("fcitx" | "fcitx5" | "'fcitx'" | "'fcitx5'" | "\"fcitx\"" | "\"fcitx5\"")
        );
        if !selected || words.next().is_some() {
            return None;
        }
        selected_fcitx = true;
    }
    selected_fcitx.then_some("fcitx")
}

fn has_explicit_gtk_module(settings: &str) -> bool {
    let mut in_settings = false;
    for line in settings.lines().map(str::trim) {
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_settings = line == "[Settings]";
        } else if in_settings
            && line
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == "gtk-im-module")
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::gtk_input_method_fallback as fallback;

    #[test]
    fn xlib_thread_initialization_checks_success_and_fails_closed() {
        use super::initialize_xlib_threads_with;
        let calls = std::cell::Cell::new(0);
        assert!(initialize_xlib_threads_with(|| {
            calls.set(calls.get() + 1);
            1
        })
        .is_ok());
        assert_eq!(calls.get(), 1);
        assert!(initialize_xlib_threads_with(|| 0).is_err());
    }

    #[test]
    fn xlib_thread_support_is_available_without_a_display_connection() {
        // SAFETY: this test binary makes no other Xlib/GTK calls; all remaining
        // compatibility tests exercise pure parsing and selection functions.
        assert!(super::initialize_xlib_threads_with(|| unsafe { super::XInitThreads() }).is_ok());
    }

    #[test]
    fn only_defaults_to_x11_when_a_display_is_available() {
        use super::should_default_to_x11;
        use std::ffi::OsStr;
        assert!(should_default_to_x11(None, Some(OsStr::new(":0"))));
        assert!(!should_default_to_x11(None, None));
        assert!(!should_default_to_x11(None, Some(OsStr::new(""))));
        for backend in ["wayland", "wayland,x11", "x11", ""] {
            assert!(!should_default_to_x11(
                Some(OsStr::new(backend)),
                Some(OsStr::new(":0"))
            ));
        }
    }

    #[test]
    fn uses_the_selected_fcitx_framework_for_x11() {
        for config in [
            "run_im fcitx5",
            "run_im fcitx",
            "# Generated by im-config\nrun_im fcitx5 # Selected framework",
            "run_im 'fcitx5'",
            "run_im \"fcitx5\"",
        ] {
            assert_eq!(fallback(false, "x11", "", config), Some("fcitx"));
        }
    }

    #[test]
    fn preserves_explicit_environment_and_gtk_settings() {
        assert_eq!(fallback(true, "x11", "", "run_im fcitx5"), None);
        for settings in [
            "[Settings]\ngtk-im-module=ibus",
            "[Settings]\ngtk-im-module=xim",
            "[Settings]\ngtk-im-module=",
        ] {
            assert_eq!(fallback(false, "x11", settings, "run_im fcitx5"), None);
        }
        assert_eq!(
            fallback(false, "x11", "[Other]\ngtk-im-module=ibus", "run_im fcitx5"),
            Some("fcitx")
        );
    }

    #[test]
    fn leaves_native_wayland_and_other_backends_untouched() {
        for backend in ["wayland", "wayland,x11", "", "broadway"] {
            assert_eq!(fallback(false, backend, "", "run_im fcitx5"), None);
        }
    }

    #[test]
    fn does_not_guess_another_framework_or_execute_shell_text() {
        for config in [
            "",
            "run_im ibus",
            "run_im auto",
            "# run_im fcitx5",
            "echo run_im fcitx5",
            "run_im fcitx5; touch /tmp/unwanted",
            "run_im $(choose-framework)",
            "run_im fcitx5\nrun_im ibus",
            "if false; then\nrun_im fcitx5\nfi",
            "INPUT_METHOD=ibus\nrun_im fcitx5",
            "run_im fcitx5#custom",
        ] {
            assert_eq!(fallback(false, "x11", "", config), None);
        }
    }
}

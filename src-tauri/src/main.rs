#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux_compat;

fn main() {
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--antigravity-statusline"))
    {
        quota_float_lib::capture_antigravity_statusline_quota();
        return;
    }

    #[cfg(target_os = "linux")]
    if let Err(error) = linux_compat::configure() {
        eprintln!("{error}");
        std::process::exit(1);
    }

    quota_float_lib::run();
}

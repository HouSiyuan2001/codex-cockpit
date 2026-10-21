#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux_compat;

fn main() {
    #[cfg(target_os = "linux")]
    if let Err(error) = linux_compat::configure() {
        eprintln!("{error}");
        std::process::exit(1);
    }

    quota_float_lib::run();
}

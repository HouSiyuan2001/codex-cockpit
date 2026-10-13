#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux_compat;

fn main() {
    #[cfg(target_os = "linux")]
    linux_compat::configure();

    quota_float_lib::run();
}

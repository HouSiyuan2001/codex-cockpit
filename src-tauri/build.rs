fn main() {
    println!("cargo:rerun-if-env-changed=COCKPIT_UPDATES_REPOSITORY");
    tauri_build::build()
}

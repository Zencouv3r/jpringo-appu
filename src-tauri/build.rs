fn main() {
    // Tauri names sidecars `<name>-<target-triple>.exe` during development, so
    // the runtime needs to know the triple it was built for. Cargo only exposes
    // TARGET to build scripts, not to the crate itself — forward it.
    println!(
        "cargo:rustc-env=RINGO_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("TARGET is always set for build scripts")
    );
    tauri_build::build()
}

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};
use crate::settings;

/// The target triple this binary was built for, injected by `build.rs`.
const TARGET_TRIPLE: &str = env!("RINGO_TARGET_TRIPLE");

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

/// The folder created beside the executable. Everything the app generates goes
/// inside it.
const DATA_DIR_NAME: &str = "ringo-data";

/// Regenerable data, kept in its own subdirectory of the data folder so
/// "Clear cache" is a directory removal that cannot reach the word log beside
/// it.
const CACHE_DIR_NAME: &str = "cache";

/// Written and immediately deleted to prove a candidate data folder accepts
/// writes. See [`is_writable`].
const WRITE_PROBE_FILE: &str = ".ringo-write-test";

/// Locates a bundled sidecar binary.
///
/// The two layouts differ, and neither is discoverable from the other:
///
/// * **Development** — sidecars sit in `src-tauri/binaries/` under their full
///   Tauri name, `<name>-<target-triple><ext>`.
/// * **Bundled** — Tauri strips the triple and copies them next to the app
///   executable as `<name><ext>`.
///
/// Checked in that order so a `cargo run` from a tree that also has a stale
/// bundled build still picks up the tree's binaries.
pub fn sidecar(name: &str) -> Result<PathBuf> {
    let mut tried = Vec::new();

    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{TARGET_TRIPLE}{EXE_SUFFIX}"));
    if dev.is_file() {
        return Ok(dev);
    }
    tried.push(dev);

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(format!("{name}{EXE_SUFFIX}"));
            if bundled.is_file() {
                return Ok(bundled);
            }
            tried.push(bundled);
        }
    }

    Err(AppError::MissingSidecar(format!(
        "Bundled `{name}` binary not found. Run `pwsh -File scripts/fetch-sidecars.ps1` \
         to download it. Looked in: {}",
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

/// True when the named sidecar is present. Used to decide whether the optional
/// GPU whisper build can be preferred over the CPU one.
pub fn has_sidecar(name: &str) -> bool {
    sidecar(name).is_ok()
}

/// Filename prefix shared by every ggml compute backend module.
const BACKEND_PREFIX: &str = "ggml-cpu-";

/// Checks that whisper's compute backends sit where ggml will actually look.
///
/// ggml does not resolve `ggml-cpu-*.dll` by name — it *enumerates* the
/// directory holding the running executable, and the working directory, and
/// loads whatever it finds. `PATH` is never consulted, so a build that files
/// those DLLs anywhere else leaves whisper with zero compute devices and no
/// way to say so: it aborts on an assertion inside upstream's code, quoting a
/// source path from the CI machine that compiled it. That message names a
/// drive the user does not have and a file they will never find, which is a
/// spectacularly unhelpful way to report "a DLL is in the wrong folder".
///
/// One directory listing per transcription turns it into a sentence naming
/// the folder that is wrong.
pub fn ensure_compute_backends(name: &str) -> Result<()> {
    let exe = sidecar(name)?;
    let Some(dir) = exe.parent() else { return Ok(()) };

    let found = std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.filter_map(|e| e.ok()).any(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with(BACKEND_PREFIX)
        })
    });
    if found {
        return Ok(());
    }

    Err(AppError::MissingSidecar(format!(
        "No `{BACKEND_PREFIX}*` compute backends beside {}. whisper loads them from \
         that folder at runtime and cannot start without one. Reinstall the app, or \
         run `pwsh -File scripts/fetch-sidecars.ps1` and rebuild.",
        dir.display()
    )))
}

/// Directories that may hold sidecar binaries and the DLLs they load at
/// runtime, most specific first.
///
/// [`crate::proc`] prepends these to a sidecar's `PATH` so its *implicit*
/// imports — whisper.dll, ggml.dll, libopenblas.dll — resolve in both the
/// development and bundled layouts. Note that this does nothing for ggml's
/// compute backends, which are found by directory scan rather than by name;
/// those are handled by [`ensure_compute_backends`] and by shipping them
/// beside the sidecar.
pub fn sidecar_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if dev.is_dir() {
        dirs.push(dev);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        dirs.push(resources.join("binaries"));
        dirs.push(resources);
    }

    dirs.retain(|d| d.is_dir());
    dirs
}

/// `%APPDATA%/app.ringo.desktop` (or the platform equivalent). Holds
/// `settings.json` and `credentials.json`, and nothing else.
///
/// Those two are the bootstrap: the data folder is *named* in `settings.json`,
/// so that file cannot live inside it. The key stays here for a second reason —
/// the OS ACLs this directory to the one user, while the folder beside the
/// executable is wherever the app was installed and is the folder somebody
/// would zip up and copy to another machine.
pub fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(format!("no config directory available: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The folder the app writes everything into: `cache/`, `vocabulary.json`, and
/// `library.json`.
///
/// Beside the executable by default rather than in the platform cache
/// directory, because what is kept here is not really the operating system's
/// idea of cache: one episode's remux is gigabytes, and the word log is the
/// only file here that cannot be regenerated for free. Both belong somewhere
/// visible, on the drive the user chose to install the app on.
///
/// Three candidates are tried, and the first writable one wins:
///
/// 1. the folder chosen in Settings, if there is one,
/// 2. `ringo-data` beside the executable,
/// 3. the per-user data directory — the last resort for an install under
///    `Program Files`, where a normal user cannot write beside the binary.
///
/// Memoised against the configured path, so the write probe and its log line
/// happen once rather than on every cache lookup.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    /// The configured path this answer was worked out for, and the answer.
    /// Held together so a changed setting invalidates the memo.
    type Memo = Option<(Option<PathBuf>, PathBuf)>;
    static RESOLVED: OnceLock<Mutex<Memo>> = OnceLock::new();

    let configured = settings::configured_data_dir(app);
    let cell = RESOLVED.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some((key, resolved)) = guard.as_ref() {
        if *key == configured {
            return Ok(resolved.clone());
        }
    }

    let resolved = resolve_data_dir(app, configured.as_deref())?;
    *guard = Some((configured, resolved.clone()));
    Ok(resolved)
}

fn resolve_data_dir(app: &AppHandle, configured: Option<&Path>) -> Result<PathBuf> {
    let mut refused = Vec::new();

    for (candidate, source) in [
        (configured.map(Path::to_path_buf), "the folder set in Settings"),
        (default_data_dir(), "the folder beside the executable"),
        (app.path().app_data_dir().ok(), "the per-user data directory"),
    ] {
        let Some(dir) = candidate else { continue };
        if is_writable(&dir) {
            if !refused.is_empty() {
                log::warn!("falling back to {source}: {}", dir.display());
            }
            return Ok(dir);
        }
        log::warn!("{source} ({}) cannot be written to", dir.display());
        refused.push(dir);
    }

    Err(AppError::Io(format!(
        "No writable data folder. Tried: {}",
        refused
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

/// `ringo-data` beside the executable.
///
/// In development that would be `src-tauri/target/debug/`, where `cargo clean`
/// would take the vocabulary log with it, so a debug build uses the repository
/// root instead. Both are "next to the app" in the sense that matters here: on
/// the same drive, visible, and not buried under `AppData`.
pub fn default_data_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return Some(root.join(DATA_DIR_NAME));
        }
    }

    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(DATA_DIR_NAME))
}

/// Creates a directory and proves it can be written to.
///
/// `create_dir_all` succeeding is not enough on its own: it returns `Ok` for a
/// directory that already exists but refuses writes, which is exactly the case
/// worth catching — an install under `Program Files` run as a normal user. A
/// file written and deleted answers the question the app actually has.
fn is_writable(dir: &Path) -> bool {
    if let Err(err) = std::fs::create_dir_all(dir) {
        log::warn!("could not create {}: {err}", dir.display());
        return false;
    }
    let probe = dir.join(WRITE_PROBE_FILE);
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(err) => {
            log::warn!("{} is not writable: {err}", dir.display());
            false
        }
    }
}

/// Cache root. Analyses live in `analyses/`, remuxed video in `media/`, and
/// scratch WAVs in `work/`.
pub fn cache_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = data_dir(app)?.join(CACHE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn cache_subdir(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let dir = cache_dir(app)?.join(name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Moves data written by an earlier build into the app's own folder.
///
/// Before the data folder existed, all of this went to the platform's per-user
/// config and cache directories — on Windows, two folders under `AppData` on
/// whichever drive Windows is installed on. Leaving it there would silently
/// reset the word log and make the user pay to look every word up again, so it
/// is moved once, at startup, and only into a slot that is still empty.
///
/// Best effort throughout: what can fail here is regenerable work at worst,
/// and refusing to start over it would be the larger loss.
pub fn migrate_legacy_data(app: &AppHandle) {
    let Ok(root) = data_dir(app) else { return };

    // The word log and the recents list, from the config directory. Small, and
    // the log is worth copying across drives if it comes to that.
    if let Ok(config) = config_dir(app) {
        if config != root {
            for name in [crate::vocab::VOCABULARY_FILE, crate::library::LIBRARY_FILE] {
                relocate(&config.join(name), &root.join(name), true);
            }
        }
    }

    // The cache. Analyses are JSON and hold the explanations that cost money,
    // so they are worth copying; `media/` and `work/` are regenerable and can
    // be tens of gigabytes, so those are only ever *renamed* — instant within
    // a drive, and skipped rather than copied across one.
    let Ok(legacy) = app.path().app_cache_dir() else { return };
    let cache = root.join(CACHE_DIR_NAME);
    if legacy == cache {
        return;
    }

    for (name, allow_copy) in [("analyses", true), ("media", false), ("work", false)] {
        let from = legacy.join(name);
        let Ok(entries) = std::fs::read_dir(&from) else { continue };
        let to = cache.join(name);
        if std::fs::create_dir_all(&to).is_err() {
            continue;
        }

        let mut left = 0;
        for entry in entries.filter_map(|e| e.ok()) {
            if !relocate(&entry.path(), &to.join(entry.file_name()), allow_copy) {
                left += 1;
            }
        }
        if left > 0 {
            log::warn!(
                "left {left} file(s) in {} — a different drive from the data folder. \
                 They are regenerable and can be deleted.",
                from.display()
            );
        }
    }
}

/// Moves one file. Returns false when it is still where it was.
///
/// A rename is the whole operation within one drive. Across drives it fails,
/// and only then is a copy considered — which the caller allows for a few
/// megabytes of JSON and refuses for a remuxed episode.
fn relocate(from: &Path, to: &Path, allow_copy: bool) -> bool {
    if !from.exists() || to.exists() {
        return !from.exists();
    }
    if std::fs::rename(from, to).is_ok() {
        log::info!("moved {} to {}", from.display(), to.display());
        return true;
    }
    if !allow_copy || from.is_dir() {
        return false;
    }
    match std::fs::copy(from, to).and_then(|_| std::fs::remove_file(from)) {
        Ok(()) => {
            log::info!("copied {} to {}", from.display(), to.display());
            true
        }
        Err(err) => {
            log::warn!("could not move {}: {err}", from.display());
            // A half-copied file left behind would look like a real one and
            // fail to parse on the next read.
            let _ = std::fs::remove_file(to);
            false
        }
    }
}

/// Default location of the whisper weights: `models/` beside the project root
/// in development, beside the executable once bundled.
pub fn default_model_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(root.join("models"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("models"));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("models"));
    }

    // Any `.bin` in the first directory that has one — the app ships a single
    // model and this saves the user from typing a path on first run.
    candidates.into_iter().find_map(|dir| {
        let entries = std::fs::read_dir(dir).ok()?;
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("bin")))
            .collect();
        found.sort();
        found.into_iter().next()
    })
}

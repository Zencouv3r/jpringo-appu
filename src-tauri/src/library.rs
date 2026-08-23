//! The "recently opened" list.
//!
//! Backed by a single JSON file rather than a database — it holds tens of
//! entries, is read once at startup, and being hand-editable when something
//! goes wrong is a feature.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::cache;
use crate::error::Result;
use crate::model::{now_secs, RecentEntry, VideoInfo};
use crate::paths;

/// Public so [`crate::paths::migrate_legacy_data`] can name the file it moves
/// out of the old per-user config directory.
pub(crate) const LIBRARY_FILE: &str = "library.json";

/// Entries kept before the oldest are dropped.
const MAX_ENTRIES: usize = 50;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Library {
    #[serde(default)]
    entries: Vec<RecentEntry>,
}

fn library_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(paths::data_dir(app)?.join(LIBRARY_FILE))
}

fn read(app: &AppHandle) -> Library {
    library_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, library: &Library) -> Result<()> {
    let path = library_path(app)?;
    std::fs::write(&path, serde_json::to_vec_pretty(library)?)?;
    Ok(())
}

/// Recent entries, newest first, with liveness re-checked against disk.
///
/// `exists` is recomputed on every read rather than trusted from the file:
/// external drives get unplugged and downloads get cleaned up, and an entry
/// that silently fails on click is worse than one visibly greyed out.
pub fn list(app: &AppHandle) -> Vec<RecentEntry> {
    let mut library = read(app);
    for entry in &mut library.entries {
        entry.exists = std::path::Path::new(&entry.path).is_file();
        entry.has_analysis = cache::any_exists(app, &entry.id);
    }
    library.entries.sort_by_key(|entry| std::cmp::Reverse(entry.opened_at));
    library.entries
}

/// Records a file as just-opened, moving it to the front if already present.
///
/// Matching is by content id, so reopening a file that has been renamed or
/// moved updates the existing entry's path instead of adding a duplicate.
pub fn touch(app: &AppHandle, info: &VideoInfo) -> Result<()> {
    let mut library = read(app);

    let position = library
        .entries
        .iter()
        .find(|e| e.id == info.id)
        .map(|e| e.position)
        .unwrap_or(0.0);
    library.entries.retain(|e| e.id != info.id);

    library.entries.insert(
        0,
        RecentEntry {
            id: info.id.clone(),
            path: info.path.clone(),
            name: info.name.clone(),
            duration: info.duration,
            opened_at: now_secs(),
            position,
            has_analysis: info.has_analysis,
            exists: true,
        },
    );

    library.entries.truncate(MAX_ENTRIES);
    write(app, &library)
}

/// Saves the playback position so reopening resumes in place.
///
/// A position within ten seconds of the end resets to zero — finishing an
/// episode and having it reopen on the credits is never what you want.
pub fn set_position(app: &AppHandle, id: &str, position: f64) -> Result<()> {
    let mut library = read(app);
    if let Some(entry) = library.entries.iter_mut().find(|e| e.id == id) {
        let near_end = entry.duration > 0.0 && position >= entry.duration - 10.0;
        entry.position = if near_end { 0.0 } else { position.max(0.0) };
        write(app, &library)?;
    }
    Ok(())
}

pub fn remove(app: &AppHandle, id: &str) -> Result<()> {
    let mut library = read(app);
    library.entries.retain(|e| e.id != id);
    write(app, &library)
}

pub fn clear(app: &AppHandle) -> Result<()> {
    write(app, &Library::default())
}

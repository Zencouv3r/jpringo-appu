//! On-disk cache of completed analyses.
//!
//! Transcribing and explaining a 24-minute episode costs minutes of CPU and a
//! real amount of money, so it happens exactly once per file. The cache key is
//! derived from the file's *contents*, not its path, which means renaming a
//! file or moving it to another drive keeps its transcript.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::language;
use crate::model::{Analysis, TranscriptChoice, ANALYSIS_VERSION};
use crate::paths;

/// Bytes sampled from each of three positions when fingerprinting a file.
const SAMPLE_SIZE: u64 = 1024 * 1024;

/// Fingerprints a video file.
///
/// Hashing several gigabytes on every open would add seconds to a click, so
/// this samples the head, middle, and tail and mixes in the exact length. Two
/// different videos would have to match in all three megabyte-wide windows
/// *and* be byte-identical in size to collide; re-encodes, different releases,
/// and truncated downloads all differ in at least one.
pub fn file_id(path: &Path) -> Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();

    let mut hasher = blake3::Hasher::new();
    hasher.update(&len.to_le_bytes());

    // Small files are hashed whole — sampling would cover them anyway.
    if len <= SAMPLE_SIZE * 3 {
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)?;
        hasher.update(&buffer);
    } else {
        for offset in [0, len / 2, len - SAMPLE_SIZE] {
            file.seek(SeekFrom::Start(offset))?;
            let mut buffer = vec![0u8; SAMPLE_SIZE as usize];
            file.read_exact(&mut buffer)?;
            hasher.update(&buffer);
        }
    }

    Ok(hasher.finalize().to_hex()[..32].to_string())
}

fn analysis_path(app: &AppHandle, video_id: &str, choice: &TranscriptChoice) -> Result<PathBuf> {
    let suffix = choice.cache_suffix();
    Ok(paths::cache_subdir(app, "analyses")?.join(format!("{video_id}{suffix}.json")))
}

/// Where a background remux writes its seekable MP4.
///
/// Keyed by audio track as well as video, because a remux bakes in exactly one
/// audio stream — reusing the file after the user switches tracks would hand
/// them the previous language with no indication anything was wrong.
pub fn remux_path(app: &AppHandle, video_id: &str, audio_track: Option<u32>) -> Result<PathBuf> {
    let suffix = audio_track.map(|i| format!("-a{i}")).unwrap_or_default();
    Ok(paths::cache_subdir(app, "media")?.join(format!("{video_id}{suffix}.mp4")))
}

/// Scratch directory for intermediate WAVs.
pub fn work_dir(app: &AppHandle) -> Result<PathBuf> {
    paths::cache_subdir(app, "work")
}

/// Loads a cached analysis, or `None` if there isn't a usable one.
///
/// A file from an older schema is migrated when the missing fields can be
/// recovered from what is already there, and discarded when they cannot. The
/// bar for migrating is high — silently deserializing stale data into a changed
/// field is a worse failure than redoing the work — but it is worth clearing
/// for a whisper transcript, which is minutes of CPU the user already spent.
pub fn load(app: &AppHandle, video_id: &str, choice: &TranscriptChoice) -> Option<Analysis> {
    let path = analysis_path(app, video_id, choice).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Analysis>(&raw) {
        Ok(analysis) if analysis.version == ANALYSIS_VERSION => Some(analysis),
        Ok(analysis) => match upgrade(analysis) {
            Some(upgraded) => {
                log::info!("migrated the cached analysis for {video_id} to v{ANALYSIS_VERSION}");
                // Rewritten so the migration happens once rather than on every
                // open; a failed write only costs the work again next time.
                let _ = save(app, &upgraded, choice);
                Some(upgraded)
            }
            None => {
                log::info!("discarding the cached analysis for {video_id}: schema too old");
                None
            }
        },
        Err(err) => {
            log::warn!("cached analysis for {video_id} is unreadable ({err}); regenerating");
            None
        }
    }
}

/// Brings an older analysis up to the current schema, or gives up.
///
/// v1 → v2 is recoverable: the only genuinely new field is the detected
/// script, which is a property of the transcript's own text and can simply be
/// re-derived. Terms lose nothing — their `grammar` field defaults to empty,
/// which reads as "no note", the same as any term the model left blank.
fn upgrade(mut analysis: Analysis) -> Option<Analysis> {
    if analysis.version != 1 {
        return None;
    }
    analysis.script =
        language::detect_lines(analysis.segments.iter().map(|s| s.text.as_str())).script;
    analysis.version = ANALYSIS_VERSION;
    Some(analysis)
}

/// True when *any* transcript choice has been analyzed for this video, which
/// is what the library list badges.
pub fn any_exists(app: &AppHandle, video_id: &str) -> bool {
    let Ok(dir) = paths::cache_subdir(app, "analyses") else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .starts_with(video_id)
    })
}

/// Writes an analysis to the cache.
///
/// The write goes to a temporary file first and is then renamed. Without that,
/// a crash midway through serializing a few megabytes of JSON leaves a
/// truncated file that looks present but fails to parse — and the app would
/// have to notice and recover from it on every subsequent open.
pub fn save(app: &AppHandle, analysis: &Analysis, choice: &TranscriptChoice) -> Result<()> {
    let path = analysis_path(app, &analysis.video_id, choice)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(analysis)?)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

pub fn remove(app: &AppHandle, video_id: &str, choice: &TranscriptChoice) -> Result<()> {
    let path = analysis_path(app, video_id, choice)?;
    if path.is_file() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

/// Total size of everything under the cache directory.
pub fn size_bytes(app: &AppHandle) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .filter_map(|e| e.ok())
            .map(|entry| match entry.metadata() {
                Ok(meta) if meta.is_dir() => walk(&entry.path()),
                Ok(meta) => meta.len(),
                Err(_) => 0,
            })
            .sum()
    }

    paths::cache_dir(app).map(|d| walk(&d)).unwrap_or(0)
}

/// Empties the cache. Analyses, remuxed video, and scratch files all go.
pub fn clear(app: &AppHandle) -> Result<()> {
    let root = paths::cache_dir(app)?;
    for name in ["analyses", "media", "work"] {
        let dir = root.join(name);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| AppError::Io(format!("could not clear {name}: {e}")))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::Script;

    /// A v1 analysis on disk has no `script` field, and defaulting it to
    /// `Unknown` would quietly demote a perfectly good Japanese transcript to
    /// "display only" — no clickable words, no breakdown, no explanation why.
    #[test]
    fn a_v1_analysis_recovers_its_script_instead_of_being_discarded() {
        let legacy = r#"{
            "version": 1,
            "videoId": "abc",
            "source": "whisper",
            "language": "ja",
            "segments": [
                {"id":0,"start":0.0,"end":2.0,
                 "text":"おはようございます、今日はいい天気ですね。",
                 "tokens":[],"translation":"Good morning, nice weather today.",
                 "terms":[{"term":"天気","reading":"てんき","meaning":"weather",
                           "jlptLevel":"N5","note":""}]},
                {"id":1,"start":2.0,"end":4.0,
                 "text":"昨日は友達と一緒に映画を見に行きました。",
                 "tokens":[],"translation":"","terms":[]}
            ],
            "analyzed": true,
            "whisperModel": "ggml-large-v3-turbo.bin",
            "llmModel": "gpt-5-mini",
            "createdAt": 0
        }"#;

        let parsed: Analysis = serde_json::from_str(legacy).expect("v1 still deserializes");
        let upgraded = upgrade(parsed).expect("v1 is migratable");

        assert_eq!(upgraded.version, ANALYSIS_VERSION);
        assert_eq!(upgraded.script, Script::Japanese);
        assert!(upgraded.is_explainable());
        // The expensive parts survive untouched.
        assert_eq!(upgraded.segments.len(), 2);
        assert_eq!(upgraded.segments[0].translation, "Good morning, nice weather today.");
        // A term written before `grammar` existed reads as having no note,
        // which is the same thing an unexplained term says today.
        assert_eq!(upgraded.segments[0].terms[0].meaning, "weather");
        assert_eq!(upgraded.segments[0].terms[0].grammar, "");
    }

    #[test]
    fn an_unrecognised_schema_is_discarded_rather_than_guessed_at() {
        let mut analysis: Analysis = serde_json::from_str(
            r#"{"version":0,"videoId":"a","source":"whisper","language":"ja",
                "segments":[],"analyzed":false,"whisperModel":"","llmModel":"",
                "createdAt":0}"#,
        )
        .expect("parses");
        analysis.version = 0;
        assert!(upgrade(analysis).is_none());
    }
}

//! User settings and the OpenAI credential.
//!
//! The two are stored in separate files on purpose. [`Settings`] is handed to
//! the frontend wholesale; the API key never is. Nothing in the webview can
//! read the key back — it is only ever loaded inside
//! [`crate::analyze::openai`] at the moment a request is signed, so a rogue
//! script in the page has no path to it.
//!
//! The credential file is plaintext inside the per-user config directory,
//! which Windows ACLs to that user. That is the same posture as
//! `tauri-plugin-store` and most desktop apps, but it is *not* encryption at
//! rest: an upgrade to DPAPI (Windows) or the platform keychain is the
//! obvious next step if this ever ships beyond personal use.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::Result;
use crate::paths;

const SETTINGS_FILE: &str = "settings.json";
const CREDENTIALS_FILE: &str = "credentials.json";

/// Default OpenAI model for the breakdown pass. Overridable in Settings so a
/// different model can be swapped in without a rebuild.
///
/// `gpt-5-mini` rather than `gpt-5`: measured against a 40-line batch, it costs
/// roughly a ninth as much and finishes in half the time, and with
/// `DEFAULT_REASONING_EFFORT` plus the explicit one-term-per-word instruction
/// in [`crate::analyze::openai`] it produces *more* word-level terms than
/// `gpt-5` does with full reasoning. Its weak spot is slightly looser JLPT
/// tagging; switch to `gpt-5` in Settings if that matters more than cost.
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-5-mini";

/// Default reasoning budget for the breakdown pass.
///
/// Reasoning tokens dominate both the bill and the wall clock here — on a
/// 40-line batch `gpt-5` spent 6144 of 11294 completion tokens thinking. The
/// task is extraction and translation against a fixed schema rather than
/// multi-step problem solving, so `minimal` loses very little: the one thing it
/// degrades is the model's tendency to split lines into individual words, and
/// the prompt now asks for that explicitly instead.
pub const DEFAULT_REASONING_EFFORT: &str = "minimal";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Absolute path to the whisper `.bin` weights. `None` means "auto-detect
    /// from the models directory", which is what a fresh install does.
    pub model_path: Option<String>,
    pub openai_model: String,
    /// `minimal` | `low` | `medium` | `high`, or empty to omit the parameter
    /// entirely (required for non-GPT-5 models, which reject the field).
    pub reasoning_effort: String,
    /// Threads for whisper.cpp. Defaults to the physical core count; going
    /// past it costs more than it gains on this workload.
    pub whisper_threads: usize,
    /// Prefer the GPU whisper sidecar when one has been installed. Ignored
    /// (with a log line) when it has not — see [`crate::transcribe`].
    pub use_gpu: bool,
    /// Use an existing Japanese subtitle track instead of running whisper,
    /// when the file has one. Turning this off forces transcription.
    pub prefer_existing_subtitles: bool,
    /// Transcript lines per OpenAI request. Larger batches give the model more
    /// context but risk truncating against the output token ceiling.
    pub batch_size: usize,
    /// How many breakdown requests may be in flight at once.
    pub concurrency: usize,
    /// After opening a file that needs remuxing, build a cached MP4 in the
    /// background so seeking becomes exact instead of restart-based.
    pub prepare_remux: bool,
    /// Language code handed to whisper. `auto` detects, but pinning `ja`
    /// measurably reduces the model drifting into romaji on sparse audio.
    pub language: String,
    /// Where the app keeps everything it generates — the analysis cache, the
    /// vocabulary log, and the recents list. `None` means the default,
    /// [`crate::paths::default_data_dir`], which is a `ringo-data` folder
    /// beside the executable.
    ///
    /// This file is the one thing that cannot live there, since it is what
    /// says where "there" is.
    pub data_dir: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_path: None,
            openai_model: DEFAULT_OPENAI_MODEL.to_string(),
            reasoning_effort: DEFAULT_REASONING_EFFORT.to_string(),
            whisper_threads: default_threads(),
            use_gpu: true,
            prefer_existing_subtitles: true,
            batch_size: 40,
            concurrency: 3,
            prepare_remux: true,
            language: "ja".to_string(),
            data_dir: None,
        }
    }
}

fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 16)
}

impl Settings {
    /// Clamps values that would otherwise be able to wedge the app — a zero
    /// batch size loops forever, and unbounded concurrency invites OpenAI rate
    /// limits. The frontend validates too; this is the backstop.
    fn sanitize(mut self) -> Self {
        self.whisper_threads = self.whisper_threads.clamp(1, 32);
        self.batch_size = self.batch_size.clamp(5, 200);
        self.concurrency = self.concurrency.clamp(1, 8);
        if self.openai_model.trim().is_empty() {
            self.openai_model = DEFAULT_OPENAI_MODEL.to_string();
        }
        if self.language.trim().is_empty() {
            self.language = "ja".to_string();
        }
        // An empty string and "unset" mean the same thing to a user who
        // cleared the field, and only one of them resolves to the default.
        self.data_dir = self
            .data_dir
            .map(|dir| dir.trim().to_string())
            .filter(|dir| !dir.is_empty());
        // An unrecognised effort would be rejected by the API mid-run, long
        // after the expensive transcription has already happened.
        if !matches!(
            self.reasoning_effort.trim(),
            "" | "minimal" | "low" | "medium" | "high"
        ) {
            self.reasoning_effort = DEFAULT_REASONING_EFFORT.to_string();
        }
        self
    }

    /// Resolves the whisper weights to use, falling back to auto-detection.
    pub fn resolve_model_path(&self, app: &AppHandle) -> Option<PathBuf> {
        match self.model_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(explicit) => Some(PathBuf::from(explicit)),
            None => paths::default_model_path(app),
        }
    }
}

/// The data folder the user has chosen, if any.
///
/// Split out from [`load`] because [`crate::paths::data_dir`] needs exactly
/// this one field and nothing else — and because it makes the direction of the
/// dependency explicit: settings are read from the config directory, which is
/// resolved without reference to the data folder, so there is no cycle.
pub fn configured_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let settings = load(app);
    let dir = settings.data_dir?;
    let trimmed = dir.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(paths::config_dir(app)?.join(SETTINGS_FILE))
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(paths::config_dir(app)?.join(CREDENTIALS_FILE))
}

/// Loads settings, falling back to defaults for a missing *or corrupt* file.
///
/// A malformed settings file should not brick the app — the user has no way to
/// repair it from inside the UI, so a bad parse resets rather than errors.
pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(settings) => settings.sanitize(),
            Err(err) => {
                log::warn!("settings.json is malformed ({err}); using defaults");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: Settings) -> Result<Settings> {
    let settings = settings.sanitize();
    let path = settings_path(app)?;
    std::fs::write(&path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(settings)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    openai_api_key: Option<String>,
}

/// Returns the configured OpenAI key, or `None` if there isn't one.
///
/// In development only, an unset key falls back to the repo-root `APIKEY`
/// file, which carries a throwaway key for testing. That file is gitignored,
/// and this path is compiled out of release builds entirely.
pub fn api_key(app: &AppHandle) -> Option<String> {
    if let Ok(path) = credentials_path(app) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(creds) = serde_json::from_str::<Credentials>(&raw) {
                if let Some(key) = creds.openai_api_key.filter(|k| !k.trim().is_empty()) {
                    return Some(key.trim().to_string());
                }
            }
        }
    }

    #[cfg(debug_assertions)]
    {
        if let Some(key) = dev_api_key() {
            return Some(key);
        }
    }

    None
}

/// Reads `APIKEY` from the project root, accepting either a bare key or a
/// `OPENAI_API_KEY=...` line.
#[cfg(debug_assertions)]
fn dev_api_key() -> Option<String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let raw = std::fs::read_to_string(root.join("APIKEY")).ok()?;
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.strip_prefix("OPENAI_API_KEY=").unwrap_or(line).trim())
        .find(|key| key.starts_with("sk-"))
        .map(str::to_string)
}

pub fn set_api_key(app: &AppHandle, key: Option<String>) -> Result<()> {
    let path = credentials_path(app)?;
    let creds = Credentials {
        openai_api_key: key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()),
    };
    std::fs::write(&path, serde_json::to_vec_pretty(&creds)?)?;
    Ok(())
}

/// Whether a breakdown can be attempted at all. Cheaper than handing the key
/// itself to the frontend, which we never do.
pub fn has_api_key(app: &AppHandle) -> bool {
    api_key(app).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_valid_reasoning_efforts() {
        for effort in ["", "minimal", "low", "medium", "high"] {
            let settings = Settings { reasoning_effort: effort.into(), ..Default::default() }.sanitize();
            assert_eq!(settings.reasoning_effort, effort);
        }
    }

    #[test]
    fn replaces_an_unrecognised_reasoning_effort() {
        // The API rejects an unknown value, and it would do so only after
        // transcription had already run.
        let settings = Settings { reasoning_effort: "turbo".into(), ..Default::default() }.sanitize();
        assert_eq!(settings.reasoning_effort, DEFAULT_REASONING_EFFORT);
    }

    #[test]
    fn clamps_batching_into_a_workable_range() {
        let settings = Settings { batch_size: 0, concurrency: 99, ..Default::default() }.sanitize();
        assert!(settings.batch_size >= 5);
        assert!((1..=8).contains(&settings.concurrency));
    }

    #[test]
    fn a_blank_data_folder_means_the_default() {
        // The field is a text box: clearing it leaves an empty string, and
        // an empty string as a path resolves to the process's working
        // directory rather than to "unset".
        for blank in ["", "   "] {
            let settings =
                Settings { data_dir: Some(blank.into()), ..Default::default() }.sanitize();
            assert_eq!(settings.data_dir, None);
        }

        let settings =
            Settings { data_dir: Some("  D:/Ringo  ".into()), ..Default::default() }.sanitize();
        assert_eq!(settings.data_dir.as_deref(), Some("D:/Ringo"));
    }

    #[test]
    fn settings_written_by_an_older_build_still_load() {
        // `reasoning_effort` did not exist in the first release; a settings
        // file from then must not fail to parse.
        let legacy = r#"{"openaiModel":"gpt-5","batchSize":25}"#;
        let parsed: Settings = serde_json::from_str(legacy).expect("parses");
        let settings = parsed.sanitize();
        assert_eq!(settings.openai_model, "gpt-5");
        assert_eq!(settings.batch_size, 25);
        assert_eq!(settings.reasoning_effort, DEFAULT_REASONING_EFFORT);
        // No data folder was recorded then, which reads as "use the default"
        // — the same answer a fresh install gives.
        assert_eq!(settings.data_dir, None);
    }
}

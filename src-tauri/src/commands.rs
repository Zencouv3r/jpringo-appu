//! The IPC surface.
//!
//! Every command is thin on purpose: validate, delegate, return. The frontend
//! mirror of this file is `src/lib/ipc.ts`, and the two are meant to be read
//! side by side.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::anki::{self, AnkiExport, AnkiOptions, AnkiPreview};
use crate::cache;
use crate::error::{AppError, Result};
use crate::library;
use crate::media::probe;
use crate::media::server::{MediaEntry, MediaRegistry};
use crate::model::{
    Analysis, KanjiDetail, KanjiStat, Playback, RecentEntry, TranscriptChoice, VideoInfo,
    VocabEntry, VocabPage, VocabQuery, VocabSourceSummary,
};
use crate::paths;
use crate::pipeline::{self, CancelFlag};
use crate::settings::{self, Settings};
use crate::vocab;

/// Long-lived app state.
pub struct AppState {
    pub media: MediaRegistry,
    /// Cancellation handles for analyses currently running, keyed by video id.
    pub jobs: Arc<Mutex<HashMap<String, CancelFlag>>>,
}

/// What the frontend needs to show a file: its metadata plus the URL to play.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedVideo {
    #[serde(flatten)]
    pub info: VideoInfo,
    pub stream_url: String,
    /// Resume point from the last session, in seconds.
    pub position: f64,
    /// True while playback is coming from the live remux stream, where seeking
    /// restarts the stream instead of jumping within it.
    pub seek_is_approximate: bool,
    /// Absolute stream index of the audio track currently playing, or `None`
    /// for the container's default.
    pub audio_track: Option<u32>,
}

/// Probes a file, registers it for playback, and records it as recently opened.
///
/// Deliberately does *not* start an analysis — opening a file to skim it
/// shouldn't spend money or pin a CPU core. The frontend calls
/// [`start_transcript`] when a transcript is wanted, and [`start_breakdown`]
/// separately for the paid explanations.
#[tauri::command]
pub async fn open_video(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<OpenedVideo> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(AppError::NotFound(format!("{path} could not be found.")));
    }

    // Hashing reads a few megabytes; keep it off the async runtime's workers.
    let id = {
        let file = file.clone();
        tokio::task::spawn_blocking(move || cache::file_id(&file))
            .await
            .map_err(AppError::other)??
    };

    let mut info = probe::probe(&app, &file, id.clone()).await?;
    info.has_analysis = cache::any_exists(&app, &id);

    // A remuxed copy from a previous session makes this file directly
    // seekable again without redoing the work. Only the default-track remux
    // is looked up here — a non-default track always starts on the live
    // stream, since resuming a specific track across sessions isn't tracked.
    let remuxed = cache::remux_path(&app, &id, None).ok().filter(|p| p.is_file());
    let needs_remux = info.playback == Playback::Remux && remuxed.is_none();

    state
        .media
        .register(
            id.clone(),
            MediaEntry {
                path: file.clone(),
                playback: info.playback,
                video_codec: info.video_codec.clone(),
                audio_codec: info.audio_codec.clone(),
                audio_tracks: info.audio_tracks.clone(),
                remuxed,
                audio_track: None,
            },
        )
        .await;

    let entry = state
        .media
        .get(&id)
        .await
        .ok_or_else(|| AppError::other("media registration failed"))?;
    let stream_url = state
        .media
        .url_for(&id, &entry)
        .await
        .ok_or_else(|| AppError::other("the media server is not running"))?;

    library::touch(&app, &info)?;
    let position = library::list(&app)
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| e.position)
        .unwrap_or(0.0);

    if needs_remux && settings::load(&app).prepare_remux {
        spawn_background_remux(&app, &state, &info, None);
    }

    Ok(OpenedVideo {
        seek_is_approximate: needs_remux,
        info,
        stream_url,
        position,
        audio_track: None,
    })
}

/// Switches which audio track the player uses.
///
/// WebView2 exposes no `audioTracks` API on `<video>`, so there is no
/// client-side way to pick a track out of a file that already has several
/// muxed in — the only lever is handing the element a *stream* that already
/// contains just the one the user wants. That means every track change is a
/// remux: this always starts a live stream immediately (so switching feels
/// instant) and, if the user has background remuxing on, kicks off a cached
/// copy for exact seeking on that track.
#[tauri::command]
pub async fn switch_audio_track(
    app: AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    audio_track: Option<u32>,
) -> Result<String> {
    // Look up any existing remux for this exact track before switching state,
    // since `set_audio_track` clears `remuxed` on a real change.
    let cached_remux = cache::remux_path(&app, &video_id, audio_track)
        .ok()
        .filter(|p| p.is_file());

    let mut entry = state
        .media
        .set_audio_track(&video_id, audio_track)
        .await
        .ok_or_else(|| AppError::NotFound("That video isn't open.".into()))?;

    if let Some(path) = cached_remux {
        state.media.set_remuxed(&video_id, audio_track, path).await;
        entry = state
            .media
            .get(&video_id)
            .await
            .ok_or_else(|| AppError::other("media entry vanished"))?;
    } else if settings::load(&app).prepare_remux {
        if let Ok(info) = probe::probe(&app, &entry.path, video_id.clone()).await {
            spawn_background_remux(&app, &state, &info, audio_track);
        }
    }

    state
        .media
        .url_for(&video_id, &entry)
        .await
        .ok_or_else(|| AppError::other("the media server is not running"))
}

/// Starts a background remux and, on success, registers it as the seekable
/// source for the given (video, audio track) pair.
fn spawn_background_remux(
    app: &AppHandle,
    state: &State<'_, AppState>,
    info: &VideoInfo,
    audio_track: Option<u32>,
) {
    let app_handle = app.clone();
    let registry = state.media.clone();
    let info = info.clone();
    tauri::async_runtime::spawn(async move {
        match pipeline::prepare_remux(&app_handle, &info, audio_track).await {
            Ok(path) => registry.set_remuxed(&info.id, audio_track, path).await,
            Err(err) => log::warn!("background remux failed: {err}"),
        }
    });
}

/// Returns the current playback URL, which changes once a background remux
/// finishes. The frontend polls this to upgrade from stream to direct.
#[tauri::command]
pub async fn stream_url(state: State<'_, AppState>, video_id: String) -> Result<Option<String>> {
    let Some(entry) = state.media.get(&video_id).await else {
        return Ok(None);
    };
    // Only answer once seeking is genuinely exact. Handing back the live
    // stream's URL would make the player swap sources for no gain.
    if !entry.is_exact() {
        return Ok(None);
    }
    Ok(state.media.url_for(&video_id, &entry).await)
}

#[tauri::command]
pub fn get_analysis(app: AppHandle, video_id: String, choice: TranscriptChoice) -> Option<Analysis> {
    cache::load(&app, &video_id, &choice)
}

/// Builds the transcript, and nothing else.
///
/// Reads an existing subtitle track, or — for [`TranscriptChoice::Whisper`] —
/// transcribes the audio locally. Never touches the network and never spends
/// anything, which is why the UI can call it the moment a subtitle track is
/// picked. Progress arrives out-of-band as [`pipeline::PROGRESS_EVENT`]
/// events; this returns once, at the end, which for whisper is minutes later.
#[tauri::command]
pub async fn start_transcript(
    app: AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    choice: TranscriptChoice,
    force: bool,
) -> Result<Analysis> {
    let info = reprobe(&app, &state, &video_id).await?;
    let job = claim_job(&state, &video_id).await?;

    pipeline::transcribe(&app, &info, &choice, force, job.flag()).await
}

/// Runs the paid passes over a transcript that already exists.
///
/// Fails rather than transcribing when there is nothing to explain: the two
/// halves are separate actions, and quietly starting a six-minute whisper run
/// because a button said "Explain" would be a surprise nobody asked for.
#[tauri::command]
pub async fn start_breakdown(
    app: AppHandle,
    state: State<'_, AppState>,
    video_id: String,
    choice: TranscriptChoice,
) -> Result<Analysis> {
    let info = reprobe(&app, &state, &video_id).await?;
    let job = claim_job(&state, &video_id).await?;

    pipeline::explain(&app, &info, &choice, job.flag()).await
}

/// Re-probes an open file.
///
/// Cheap, and it keeps these commands independent of whatever the frontend
/// still has cached from `open_video` — which may be minutes stale by the time
/// the user asks for a transcript.
async fn reprobe(
    app: &AppHandle,
    state: &State<'_, AppState>,
    video_id: &str,
) -> Result<VideoInfo> {
    let entry = state
        .media
        .get(video_id)
        .await
        .ok_or_else(|| AppError::NotFound("That video isn't open.".into()))?;

    let mut info = probe::probe(app, &entry.path, video_id.to_string()).await?;
    info.has_analysis = cache::any_exists(app, video_id);
    Ok(info)
}

/// Holds a video's slot in [`AppState::jobs`] for as long as it exists.
///
/// Releasing on drop rather than after the `await` is what keeps a refusal
/// temporary. The slot is what makes a second concurrent run impossible, so a
/// run that ends without clearing it locks the file out for the rest of the
/// session — and a command's future does not always reach its last line: the
/// window can close mid-transcription, and a panic anywhere in the pipeline
/// unwinds straight past it. Both used to leave the video permanently "busy",
/// with nothing in the UI to say why or any way to clear it short of a
/// restart.
struct JobGuard {
    jobs: Arc<Mutex<HashMap<String, CancelFlag>>>,
    video_id: String,
    cancel: CancelFlag,
}

impl JobGuard {
    fn flag(&self) -> CancelFlag {
        self.cancel.clone()
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        // The map lives behind an async mutex and `Drop` cannot await. It is
        // only ever held for a `HashMap` lookup by three short functions in
        // this file, so the lock is free in practice and the removal happens
        // right here.
        if let Ok(mut jobs) = self.jobs.try_lock() {
            jobs.remove(&self.video_id);
            return;
        }
        // Contended — another command is mid-lookup. Hand the removal to the
        // runtime rather than blocking a drop on it.
        let jobs = self.jobs.clone();
        let video_id = std::mem::take(&mut self.video_id);
        tauri::async_runtime::spawn(async move {
            jobs.lock().await.remove(&video_id);
        });
    }
}

/// Registers a cancellable job for this video, refusing a second concurrent run.
async fn claim_job(state: &State<'_, AppState>, video_id: &str) -> Result<JobGuard> {
    let cancel = CancelFlag::default();
    let mut jobs = state.jobs.lock().await;
    if jobs.contains_key(video_id) {
        return Err(AppError::Busy(
            "Something is already running for this file.".into(),
        ));
    }
    jobs.insert(video_id.to_string(), cancel.clone());
    Ok(JobGuard {
        jobs: state.jobs.clone(),
        video_id: video_id.to_string(),
        cancel,
    })
}

#[tauri::command]
pub async fn cancel_analysis(state: State<'_, AppState>, video_id: String) -> Result<()> {
    if let Some(flag) = state.jobs.lock().await.get(&video_id) {
        flag.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn list_recent(app: AppHandle) -> Vec<RecentEntry> {
    library::list(&app)
}

#[tauri::command]
pub fn remove_recent(app: AppHandle, video_id: String) -> Result<()> {
    library::remove(&app, &video_id)
}

#[tauri::command]
pub fn clear_recent(app: AppHandle) -> Result<()> {
    library::clear(&app)
}

#[tauri::command]
pub fn save_position(app: AppHandle, video_id: String, position: f64) -> Result<()> {
    library::set_position(&app, &video_id, position)
}

/// Settings plus the derived facts the settings UI needs to explain itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub settings: Settings,
    pub has_api_key: bool,
    /// Resolved model path, so the UI can show what auto-detection found.
    pub resolved_model_path: Option<String>,
    pub model_available: bool,
    /// Whether the optional GPU whisper build is installed.
    pub gpu_available: bool,
    pub cache_bytes: u64,
    /// Distinct words in the vocabulary log. Shown next to its Clear button,
    /// which throws away paid-for definitions and should say so.
    pub vocabulary_words: usize,
    /// The folder actually in use, after the fallbacks in
    /// [`crate::paths::data_dir`]. `None` only if none of them was writable,
    /// which is a broken install rather than a setting.
    pub resolved_data_dir: Option<String>,
    /// Where the default would put it, shown as the placeholder for the field.
    pub default_data_dir: Option<String>,
    /// False when a folder *was* chosen and is not the one in use — it could
    /// not be written to, and the app quietly fell back. Without this the UI
    /// would show a path that nothing is being written to.
    pub data_dir_available: bool,
}

fn settings_view(app: &AppHandle, settings: Settings) -> SettingsView {
    let resolved = settings.resolve_model_path(app);
    let data_dir = paths::data_dir(app).ok();
    let chosen = settings
        .data_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);

    SettingsView {
        has_api_key: settings::has_api_key(app),
        model_available: resolved.as_ref().is_some_and(|p| p.is_file()),
        resolved_model_path: resolved.map(|p| p.to_string_lossy().into_owned()),
        gpu_available: paths::has_sidecar("whisper-cli-gpu"),
        cache_bytes: cache::size_bytes(app),
        vocabulary_words: vocab::word_count(app),
        data_dir_available: match (&chosen, &data_dir) {
            (Some(chosen), Some(actual)) => chosen == actual,
            // Nothing chosen, so whatever the default resolved to is right by
            // definition.
            _ => true,
        },
        resolved_data_dir: data_dir.map(|p| p.to_string_lossy().into_owned()),
        default_data_dir: paths::default_data_dir().map(|p| p.to_string_lossy().into_owned()),
        settings,
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsView {
    let settings = settings::load(&app);
    settings_view(&app, settings)
}

/// Saves settings, and follows the data folder if it moved.
///
/// The vocabulary log is held in memory once loaded, so a change of folder has
/// to drop that copy: otherwise the next word recorded would flush the log
/// belonging to the old location into the new one.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<SettingsView> {
    let before = paths::data_dir(&app).ok();
    let saved = settings::save(&app, settings)?;
    if paths::data_dir(&app).ok() != before {
        vocab::forget_cached();
    }
    Ok(settings_view(&app, saved))
}

/// Stores the OpenAI key. Passing `null` clears it.
///
/// There is deliberately no command to read the key back — once set, it only
/// ever leaves this process as an `Authorization` header.
#[tauri::command]
pub fn set_api_key(app: AppHandle, key: Option<String>) -> Result<bool> {
    settings::set_api_key(&app, key)?;
    Ok(settings::has_api_key(&app))
}

#[tauri::command]
pub fn clear_cache(app: AppHandle) -> Result<u64> {
    cache::clear(&app)?;
    Ok(cache::size_bytes(&app))
}

#[tauri::command]
pub fn remove_analysis(app: AppHandle, video_id: String, choice: TranscriptChoice) -> Result<()> {
    cache::remove(&app, &video_id, &choice)
}

// ---------------------------------------------------------------------------
// The vocabulary log
// ---------------------------------------------------------------------------

/// One page of the dictionary screen: filtered, sorted, and counted.
#[tauri::command]
pub fn list_words(app: AppHandle, query: VocabQuery) -> VocabPage {
    vocab::query(&app, &query)
}

/// Everything known about one word, for the word panel and the detail view.
///
/// Returns `None` for a word that has never been met, which is the normal
/// answer for a transcript that has not been through the breakdown yet.
#[tauri::command]
pub fn get_word(app: AppHandle, lemma: String) -> Option<VocabEntry> {
    vocab::lookup(&app, &lemma)
}

/// Kanji frequency across everything watched. `limit` of zero means all of it.
#[tauri::command]
pub fn list_kanji(app: AppHandle, limit: usize) -> Vec<KanjiStat> {
    vocab::kanji(&app, limit)
}

/// Everything the log knows about one kanji, for the panel beside the grid.
///
/// `None` for a character the user has never met, which is what every kanji
/// looks like before a transcript has been recorded.
#[tauri::command]
pub fn get_kanji(app: AppHandle, character: String) -> Option<KanjiDetail> {
    vocab::kanji_detail(&app, &character)
}

/// The series and videos words have been met in, for the filter menu.
#[tauri::command]
pub fn list_word_sources(app: AppHandle) -> Vec<VocabSourceSummary> {
    vocab::sources(&app)
}

/// Empties the vocabulary log — encounters *and* cached definitions.
#[tauri::command]
pub fn clear_vocabulary(app: AppHandle) -> Result<usize> {
    vocab::clear(&app)?;
    Ok(vocab::word_count(&app))
}

// ---------------------------------------------------------------------------
// Anki export
// ---------------------------------------------------------------------------

/// What the current export options would produce, without writing anything.
///
/// Called on every change in the export dialog, which is affordable for the
/// same reason [`list_words`] is: the log is already in memory, and sifting a
/// few thousand entries costs less than the round trip.
#[tauri::command]
pub fn preview_anki_export(app: AppHandle, options: AnkiOptions) -> AnkiPreview {
    anki::preview(&app, &options)
}

/// Writes the export to `path`, which the frontend gets from a save dialog.
///
/// The path is chosen by the user through the native picker rather than being
/// composed here: this is the one thing the app writes that is meant to be
/// found again by hand.
#[tauri::command]
pub fn export_anki(app: AppHandle, options: AnkiOptions, path: String) -> Result<AnkiExport> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err(AppError::InvalidInput("No file was chosen.".into()));
    }
    anki::export(&app, &options, &path)
}

// ---------------------------------------------------------------------------
// Colour schemes
// ---------------------------------------------------------------------------

/// Largest colour scheme worth reading or writing.
///
/// A scheme is a couple of dozen colour strings — under a kilobyte in
/// practice, and this is generous by two orders of magnitude.
///
/// On the way in, the cap is there because the path comes from a file picker
/// with no filter the user cannot override, and reading a mis-picked MKV into
/// a `String` would mean holding a whole episode in memory before discovering
/// it isn't JSON. On the way out it bounds what these two commands — the only
/// pair in the app that names an arbitrary path — can put on disk.
const MAX_SCHEME_BYTES: u64 = 256 * 1024;

/// Writes a colour scheme to `path`, which the frontend gets from a save dialog.
///
/// The web layer owns the format — the scheme lives in `localStorage`, and this
/// side neither parses it nor validates it. What it owns is the filesystem,
/// which the webview has no access to at all. The same division as
/// [`export_anki`], minus the rendering.
#[tauri::command]
pub fn write_color_scheme(path: String, contents: String) -> Result<String> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err(AppError::InvalidInput("No file was chosen.".into()));
    }
    // The same ceiling the read side enforces, applied here so the two agree:
    // this command can write anywhere the user can, and a scheme is a couple
    // of dozen colour strings. Anything larger is not one, whatever produced
    // it, and there is no reason for this to be the app's general-purpose way
    // of putting bytes on disk.
    if contents.len() as u64 > MAX_SCHEME_BYTES {
        return Err(AppError::InvalidInput(
            "That is far too large to be a colour scheme.".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(&path, contents)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Reads a colour scheme file back, for the frontend to parse.
///
/// Errors are worded for the person who just picked the file, because they are
/// shown verbatim next to the Import button.
#[tauri::command]
pub fn read_color_scheme(path: String) -> Result<String> {
    let path = PathBuf::from(path);
    let metadata = std::fs::metadata(&path)
        .map_err(|err| AppError::Io(format!("That file can't be read: {err}")))?;
    if metadata.len() > MAX_SCHEME_BYTES {
        return Err(AppError::InvalidInput(
            "That file is far too big to be a colour scheme.".into(),
        ));
    }
    std::fs::read_to_string(&path)
        .map_err(|_| AppError::InvalidInput("That file isn't text.".into()))
}

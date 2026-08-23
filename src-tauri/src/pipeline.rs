//! Orchestration: video file in, cached [`Analysis`] out.
//!
//! The work splits into two runs, because the two halves cost wildly different
//! things and the user should be able to ask for them separately.
//!
//! **[`transcribe`]** produces the lines. Either it reads a subtitle track the
//! file already carries — instant, free, and available in any language — or it
//! runs whisper over the audio, which pins a CPU core for several minutes and
//! is why that path is only ever taken when explicitly asked for. Japanese
//! transcripts are then tokenized with Lindera so words are clickable, and
//! every word met is folded into the vocabulary log.
//!
//! **[`explain`]** is the paid half: dictionary senses for words not already
//! cached, then a per-line translation and in-context breakdown. It needs a
//! Japanese transcript and an API key, and it never runs on its own.
//!
//! Keeping them apart means a failed, cancelled, or unfunded breakdown never
//! costs the expensive local work — the transcript is already on disk.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::analyze::{dictionary, openai, tokenize};
use crate::cache;
use crate::error::{AppError, Result};
use crate::language::Script;
use crate::media::{audio, probe, subtitles};
use crate::model::{
    now_secs, Analysis, Segment, TranscriptChoice, TranscriptSource, VideoInfo, ANALYSIS_VERSION,
};
use crate::settings::{self, Settings};
use crate::transcribe;
use crate::vocab;

/// Event name the frontend listens on for pipeline progress.
pub const PROGRESS_EVENT: &str = "ringo://progress";

/// A progress update. Serialized with an internal `stage` tag so the frontend
/// can switch on it exhaustively.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum Stage {
    /// Reading an existing subtitle track. `track` is its absolute stream
    /// index, or `None` for an external file.
    ReadingSubtitles { track: Option<u32> },
    /// A candidate subtitle track was extracted and then rejected. Emitted so
    /// the UI can explain why the app fell through to whisper instead of
    /// silently taking longer than expected.
    SubtitleRejected { track: String, reason: String },
    /// Decoding audio to 16 kHz mono PCM.
    ExtractingAudio,
    Transcribing { percent: u8 },
    Tokenizing,
    /// Looking up dictionary senses for words not already in the vocabulary
    /// store. Skipped entirely when every word is already known.
    LookingUpWords { done: usize, total: usize },
    Analyzing { done: usize, total: usize },
    Done,
    Failed { message: String },
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    video_id: String,
    #[serde(flatten)]
    stage: Stage,
}

fn emit(app: &AppHandle, video_id: &str, stage: Stage) {
    // A failed emit means the window is gone; the work is about to be
    // cancelled anyway, so there is nothing useful to do with the error.
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent { video_id: video_id.to_string(), stage },
    );
}

/// Cooperative cancellation. Checked between stages and inside the whisper
/// progress callback — killing a child mid-write would leave a partial WAV.
#[derive(Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(AppError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Reports the outcome of a run through the progress channel and passes it on.
async fn reporting<F>(app: &AppHandle, video_id: &str, run: F) -> Result<Analysis>
where
    F: std::future::Future<Output = Result<Analysis>>,
{
    match run.await {
        Ok(analysis) => {
            emit(app, video_id, Stage::Done);
            Ok(analysis)
        }
        Err(AppError::Cancelled) => {
            emit(app, video_id, Stage::Cancelled);
            Err(AppError::Cancelled)
        }
        Err(err) => {
            emit(app, video_id, Stage::Failed { message: err.to_string() });
            Err(err)
        }
    }
}

/// Produces the transcript for one video, without spending anything.
///
/// A cached transcript for this exact choice is returned as-is; `force`
/// regenerates it. Nothing here touches the network.
pub async fn transcribe(
    app: &AppHandle,
    info: &VideoInfo,
    choice: &TranscriptChoice,
    force: bool,
    cancel: CancelFlag,
) -> Result<Analysis> {
    let settings = settings::load(app);
    reporting(app, &info.id, transcribe_inner(app, info, &settings, choice, force, &cancel)).await
}

async fn transcribe_inner(
    app: &AppHandle,
    info: &VideoInfo,
    settings: &Settings,
    choice: &TranscriptChoice,
    force: bool,
    cancel: &CancelFlag,
) -> Result<Analysis> {
    // A transcript that already exists is the answer, breakdown or not —
    // completing it is [`explain`]'s job, not this function's.
    if !force {
        if let Some(analysis) = cache::load(app, &info.id, choice) {
            return Ok(analysis);
        }
    }

    let path = Path::new(&info.path);
    let mut found = transcript(app, info, settings, choice, path, cancel).await?;
    cancel.check()?;

    if found.segments.is_empty() {
        return Err(AppError::NotFound("No speech was found in this file.".into()));
    }

    clamp_to_duration(&mut found.segments, info.duration);

    // Detection runs on every source, including whisper's own output: the
    // language decides whether the transcript can be tokenized and explained
    // at all, and a subtitle track's tag is not evidence of what is in it.
    let detection = subtitles::detect_segments(&found.segments);

    if detection.script == Script::Japanese {
        emit(app, &info.id, Stage::Tokenizing);
        tokenize::annotate(&mut found.segments);
        cancel.check()?;
    } else {
        // Lindera would happily segment Chinese into confident nonsense, and
        // clickable words that mean nothing are worse than plain text.
        log::info!(
            "{} is {}; showing it as plain text with no breakdown",
            info.name,
            detection.script.label()
        );
    }

    let analysis = Analysis {
        version: ANALYSIS_VERSION,
        video_id: info.id.clone(),
        source: found.source,
        language: if found.language.is_empty() {
            detection.script.code().to_string()
        } else {
            found.language
        },
        script: detection.script,
        segments: found.segments,
        analyzed: false,
        whisper_model: model_label(settings, app),
        llm_model: settings.openai_model.clone(),
        created_at: now_secs(),
    };
    cache::save(app, &analysis, choice)?;

    // Every word met counts, whether or not it is ever explained. A user with
    // no API key still builds a frequency list out of what they watch.
    if let Err(err) = vocab::record(app, &analysis, &info.name) {
        log::warn!("could not update the vocabulary log: {err}");
    }

    Ok(analysis)
}

/// Runs the paid half over a transcript that already exists.
///
/// Two passes, in this order and for this reason: dictionary senses first,
/// because they are cached forever and every later video reuses them, then the
/// per-line breakdown, which is regenerated every time because its answers are
/// only true of the lines they describe.
pub async fn explain(
    app: &AppHandle,
    info: &VideoInfo,
    choice: &TranscriptChoice,
    cancel: CancelFlag,
) -> Result<Analysis> {
    let settings = settings::load(app);
    reporting(app, &info.id, explain_inner(app, info, &settings, choice, &cancel)).await
}

async fn explain_inner(
    app: &AppHandle,
    info: &VideoInfo,
    settings: &Settings,
    choice: &TranscriptChoice,
    cancel: &CancelFlag,
) -> Result<Analysis> {
    let Some(mut analysis) = cache::load(app, &info.id, choice) else {
        return Err(AppError::NotFound(
            "There is no transcript to explain yet — generate one first.".into(),
        ));
    };

    if !analysis.is_explainable() {
        return Err(AppError::InvalidInput(format!(
            "This transcript is {}. Translations and word breakdowns are only available for \
             Japanese.",
            analysis.script.label()
        )));
    }

    let Some(api_key) = settings::api_key(app) else {
        return Err(AppError::InvalidInput(
            "Add an OpenAI API key in Settings to generate explanations.".into(),
        ));
    };

    let title = title_for(info);

    // Pass one: dictionary senses for anything the vocabulary store has not
    // seen defined before. On a second episode this list is usually short, and
    // on a re-run it is empty — which is the whole point of the cache.
    let lemmas = vocab::lemmas_of(&analysis);
    let missing = vocab::undefined(app, &lemmas);
    log::info!(
        "{}: {} distinct words, {} need a dictionary lookup",
        info.name,
        lemmas.len(),
        missing.len()
    );

    if !missing.is_empty() {
        emit(app, &info.id, Stage::LookingUpWords { done: 0, total: 0 });

        let progress_app = app.clone();
        let progress_id = info.id.clone();
        let defined = dictionary::lookup(settings, &api_key, &missing, move |done, total| {
            emit(&progress_app, &progress_id, Stage::LookingUpWords { done, total });
        })
        .await?;

        let stored = vocab::define(app, defined)?;
        log::info!("defined {stored} new words for {}", info.name);
        cancel.check()?;
    }

    // Pass two: the in-context breakdown, always regenerated.
    emit(app, &info.id, Stage::Analyzing { done: 0, total: 0 });

    let progress_app = app.clone();
    let progress_id = info.id.clone();
    let filled = openai::analyze(
        settings,
        &api_key,
        &title,
        &mut analysis.segments,
        move |done, total| {
            emit(&progress_app, &progress_id, Stage::Analyzing { done, total });
        },
    )
    .await?;

    log::info!("explained {filled}/{} segments for {}", analysis.segments.len(), info.name);
    analysis.analyzed = true;
    analysis.llm_model = settings.openai_model.clone();
    analysis.created_at = now_secs();
    cache::save(app, &analysis, choice)?;

    // Re-recorded so the log picks up the contextual meanings that did not
    // exist when the transcript was first folded in.
    if let Err(err) = vocab::record(app, &analysis, &info.name) {
        log::warn!("could not update the vocabulary log: {err}");
    }

    Ok(analysis)
}

/// What a transcript run found, before it is judged.
struct Found {
    segments: Vec<Segment>,
    source: TranscriptSource,
    /// The container's language tag for this track, when it had one. Empty
    /// otherwise — a missing tag is not a claim, and detection fills in.
    language: String,
}

/// Produces a transcript from whichever source was asked for.
///
/// An explicit pick is taken at its word: the track is read, checked for
/// dialogue, and returned **whatever language it turns out to be**. Asking for
/// the English track is not a mistake to be protected from — it just means no
/// breakdown, which the UI says plainly.
///
/// [`TranscriptChoice::Auto`] is the one that judges. Candidates are ranked and
/// each is validated **on its extracted text**, not on its language tag, which
/// is the only way to catch the two expensive mistakes: a `jpn`-tagged signs
/// track, and Chinese subtitles that every CJK-based check mistakes for
/// Japanese. Auto never falls through to whisper — transcription is minutes of
/// CPU and is only ever started by someone asking for it.
async fn transcript(
    app: &AppHandle,
    info: &VideoInfo,
    settings: &Settings,
    choice: &TranscriptChoice,
    path: &Path,
    cancel: &CancelFlag,
) -> Result<Found> {
    match choice {
        TranscriptChoice::Whisper => return whisper(app, info, settings, path, cancel).await,

        TranscriptChoice::Embedded(index) => {
            emit(app, &info.id, Stage::ReadingSubtitles { track: Some(*index) });
            let segments = subtitles::extract_embedded(app, path, *index).await?;
            // Still checked, but only for *dialogue* — and a failure is fatal
            // here rather than a reason to try something else, because the
            // user asked for this track by name.
            subtitles::check_dialogue(&segments, info.duration)?;
            return Ok(Found {
                segments,
                source: TranscriptSource::EmbeddedSubtitles,
                language: track_language(info, *index),
            });
        }

        TranscriptChoice::External(file) => {
            emit(app, &info.id, Stage::ReadingSubtitles { track: None });
            let segments = subtitles::read_external(app, Path::new(file)).await?;
            subtitles::check_dialogue(&segments, info.duration)?;
            return Ok(Found {
                segments,
                source: TranscriptSource::ExternalSubtitles,
                language: String::new(),
            });
        }

        TranscriptChoice::Auto => {}
    }

    if settings.prefer_existing_subtitles {
        for index in probe::rank_subtitle_candidates(&info.subtitle_tracks) {
            cancel.check()?;
            emit(app, &info.id, Stage::ReadingSubtitles { track: Some(index) });

            let label = format!("track {index}");
            match subtitles::extract_embedded(app, path, index).await {
                Ok(segments) => match subtitles::validate(&segments, info.duration) {
                    Ok(detection) => {
                        log::info!(
                            "using embedded subtitle stream {index} ({:.0}% kana, confidence {:.2})",
                            detection.kana_ratio * 100.0,
                            detection.japanese_confidence
                        );
                        return Ok(Found {
                            segments,
                            source: TranscriptSource::EmbeddedSubtitles,
                            language: track_language(info, index),
                        });
                    }
                    Err(err) => {
                        log::info!("subtitle {label} rejected: {err}");
                        emit(
                            app,
                            &info.id,
                            Stage::SubtitleRejected { track: label, reason: err.to_string() },
                        );
                    }
                },
                Err(err) => log::warn!("could not extract subtitle {label}: {err}"),
            }
        }

        for candidate in &info.external_subtitles {
            cancel.check()?;
            emit(app, &info.id, Stage::ReadingSubtitles { track: None });

            let label = Path::new(candidate)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| candidate.clone());

            match subtitles::read_external(app, Path::new(candidate)).await {
                Ok(segments) => match subtitles::validate(&segments, info.duration) {
                    Ok(_) => {
                        log::info!("using external subtitle file {candidate}");
                        return Ok(Found {
                            segments,
                            source: TranscriptSource::ExternalSubtitles,
                            language: String::new(),
                        });
                    }
                    Err(err) => {
                        log::info!("{label} rejected: {err}");
                        emit(
                            app,
                            &info.id,
                            Stage::SubtitleRejected { track: label, reason: err.to_string() },
                        );
                    }
                },
                Err(err) => log::warn!("could not read {candidate}: {err}"),
            }
        }
    }

    Err(AppError::NotFound(
        "No usable Japanese subtitle track was found in this file. Pick a track from the \
         transcript menu to read along in another language, or transcribe the audio."
            .into(),
    ))
}

/// The container's language tag for one subtitle stream, lowercased.
fn track_language(info: &VideoInfo, index: u32) -> String {
    info.subtitle_tracks
        .iter()
        .find(|track| track.index == index)
        .and_then(|track| track.language.clone())
        .unwrap_or_default()
}

async fn whisper(
    app: &AppHandle,
    info: &VideoInfo,
    settings: &Settings,
    path: &Path,
    cancel: &CancelFlag,
) -> Result<Found> {
    let model = settings.resolve_model_path(app).ok_or_else(|| {
        AppError::MissingModel(
            "No whisper model found. Put a ggml `.bin` model in the models directory, \
             or set its path in Settings."
                .into(),
        )
    })?;

    // Pick the Japanese-tagged track when there is more than one, rather than
    // whatever ffmpeg would default to — see probe::rank_audio_candidates.
    let audio_track = probe::rank_audio_candidates(&info.audio_tracks).into_iter().next();

    emit(app, &info.id, Stage::ExtractingAudio);
    let wav = cache::work_dir(app)?.join(format!("{}.wav", info.id));

    // The WAV is a decompressed intermediate — roughly 100 MB for an episode —
    // and every path out of here from this point on has to remove it. There
    // are four: extraction fails part way through and leaves a partial file,
    // the run is cancelled between the two stages, whisper fails, or whisper
    // succeeds. Cleaning up on drop covers all four, including the `?` below
    // that used to return before the removal and leave the file behind.
    let scratch = ScratchFile(wav.clone());

    audio::extract_wav(app, path, audio_track, &wav).await?;
    cancel.check()?;

    let progress_app = app.clone();
    let progress_id = info.id.clone();
    let segments = transcribe::transcribe(app, settings, &wav, &model, move |percent| {
        emit(&progress_app, &progress_id, Stage::Transcribing { percent });
    })
    .await?;

    drop(scratch);

    Ok(Found {
        segments,
        source: TranscriptSource::Whisper,
        language: settings.language.clone(),
    })
}

/// Removes a file when it goes out of scope, however it goes out of scope.
struct ScratchFile(std::path::PathBuf);

impl Drop for ScratchFile {
    fn drop(&mut self) {
        // Best effort: a leftover file in the scratch directory is wasted disk
        // space, and "Clear cache" takes the whole folder anyway.
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Keeps segment timings inside the video's actual length.
///
/// whisper decodes in fixed 30-second windows and reports the window's end, not
/// the speech's, so the final segment of a file routinely claims to end past
/// the video — a 20-second clip comes back ending at 30. Left alone that
/// stretches the last line across the seek bar and keeps it highlighted after
/// playback has stopped.
fn clamp_to_duration(segments: &mut [Segment], duration: f64) {
    if duration <= 0.0 {
        return;
    }
    for segment in segments {
        segment.start = segment.start.clamp(0.0, duration);
        segment.end = segment.end.clamp(segment.start, duration);
    }
}

/// Context line for the prompt. The filename is all we have, but for anime it
/// usually carries the series title and episode number, which measurably helps
/// the model resolve character names and setting-specific vocabulary.
fn title_for(info: &VideoInfo) -> String {
    Path::new(&info.name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| info.name.clone())
}

fn model_label(settings: &Settings, app: &AppHandle) -> String {
    settings
        .resolve_model_path(app)
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// Builds the seekable MP4 for a file that needs remuxing.
///
/// Runs in the background while the user is already waiting on transcription,
/// so the cost is usually invisible. Until it finishes the player uses the
/// live stream, which plays immediately but seeks by restarting.
pub async fn prepare_remux(
    app: &AppHandle,
    info: &VideoInfo,
    audio_track: Option<u32>,
) -> Result<std::path::PathBuf> {
    let dest = cache::remux_path(app, &info.id, audio_track)?;
    if dest.is_file() {
        return Ok(dest);
    }

    // Write to a temporary name and rename on success, so an interrupted
    // remux can never be mistaken for a complete one.
    let temp = dest.with_extension("mp4.part");
    let cmd = audio::remux_command(
        app,
        Path::new(&info.path),
        0.0,
        info.video_codec.as_deref(),
        // The *selected* track's codec, not the container's first — copying a
        // FLAC or DTS stream into an MP4 fails outright.
        info.audio_codec_for(audio_track),
        audio_track,
        Some(&temp),
    )?;

    crate::proc::run_capture(cmd, "ffmpeg").await?;
    std::fs::rename(&temp, &dest)?;
    log::info!("remuxed {} for seekable playback", info.name);
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::subtitles;

    /// The real data flow for the subtitle path, end to end.
    ///
    /// Everything between "ffmpeg handed us SRT bytes" and "an Analysis is on
    /// disk" runs here for real: parsing, dialogue filtering, the forced-track
    /// guard, Lindera tokenization, and the JSON round-trip. The two process
    /// spawns either side of it (ffmpeg, whisper) are covered by their own
    /// tests and by the command-line shapes in `media::audio`.
    fn sample_srt() -> &'static str {
        "1\n00:00:01,000 --> 00:00:04,000\nおはようございます、今日はいい天気ですね。\n\n\
         2\n00:00:04,500 --> 00:00:08,000\n昨日は友達と一緒に映画を見に行きました。\n\n\
         3\n00:00:08,500 --> 00:00:12,000\n{\\an8}<i>すごく面白かったよ！</i>\n\n\
         4\n00:00:12,500 --> 00:00:16,000\n♪ ラララ、歌を歌おう ♪\n\n\
         5\n00:00:16,500 --> 00:00:30,000\nそれじゃあ、また明日ね。\n\n"
    }

    #[test]
    fn subtitle_transcript_survives_the_whole_flow() {
        let mut segments = subtitles::parse_srt(sample_srt());

        // The music cue is dropped; the other four lines survive with
        // contiguous ids.
        assert_eq!(segments.len(), 4);
        assert_eq!(segments.iter().map(|s| s.id).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        // Markup is stripped rather than carried into the transcript.
        assert_eq!(segments[2].text, "すごく面白かったよ！");

        assert!(subtitles::validate(&segments, 30.0).is_ok());

        // The last cue runs to 30s in the file but the video is only 20s long.
        clamp_to_duration(&mut segments, 20.0);
        assert_eq!(segments[3].end, 20.0);
        assert!(segments.iter().all(|s| s.start <= s.end && s.end <= 20.0));

        crate::analyze::tokenize::annotate(&mut segments);

        // Tokenization is best-effort; skip the rest if the dictionary is
        // unavailable in this environment rather than failing spuriously.
        if segments[0].tokens.is_empty() {
            return;
        }

        for segment in &segments {
            let chars: Vec<char> = segment.text.chars().collect();
            for token in &segment.tokens {
                let sliced: String = chars[token.start..token.end].iter().collect();
                assert_eq!(sliced, token.surface, "token offsets must slice the line");
            }
            assert!(
                segment.tokens.iter().any(|t| t.clickable),
                "every dialogue line should have at least one clickable word"
            );
        }

        // 今日 should come back readable, which is the whole point of the panel.
        let today = segments[0]
            .tokens
            .iter()
            .find(|t| t.surface == "今日")
            .expect("今日 should be segmented as one token");
        assert_eq!(today.reading, "きょう");

        // A cached analysis has to survive the JSON round-trip unchanged —
        // this is what the app reloads on every subsequent open.
        let analysis = Analysis {
            version: ANALYSIS_VERSION,
            video_id: "test".into(),
            source: TranscriptSource::EmbeddedSubtitles,
            language: "jpn".into(),
            script: Script::Japanese,
            segments,
            analyzed: false,
            whisper_model: String::new(),
            llm_model: "gpt-5".into(),
            created_at: 0,
        };
        let encoded = serde_json::to_string(&analysis).expect("serializes");
        let decoded: Analysis = serde_json::from_str(&encoded).expect("round-trips");

        assert_eq!(decoded.segments.len(), analysis.segments.len());
        assert_eq!(decoded.segments[0].tokens.len(), analysis.segments[0].tokens.len());
        assert_eq!(decoded.segments[0].tokens[0].surface, analysis.segments[0].tokens[0].surface);
        assert_eq!(decoded.source, TranscriptSource::EmbeddedSubtitles);
        assert!(decoded.is_explainable());
    }

    #[test]
    fn clamping_leaves_well_formed_timings_alone() {
        let mut segments = subtitles::parse_srt(sample_srt());
        let before: Vec<(f64, f64)> = segments.iter().map(|s| (s.start, s.end)).collect();
        clamp_to_duration(&mut segments, 600.0);
        let after: Vec<(f64, f64)> = segments.iter().map(|s| (s.start, s.end)).collect();
        assert_eq!(before, after);
    }

    #[test]
    fn unknown_duration_does_not_zero_out_timings() {
        let mut segments = subtitles::parse_srt(sample_srt());
        // ffprobe reports 0 for some malformed containers; clamping to it
        // would collapse every segment onto the same instant.
        clamp_to_duration(&mut segments, 0.0);
        assert!(segments.iter().any(|s| s.end > 0.0));
    }
}

#[cfg(test)]
mod language_rejection_tests {
    use crate::language::Script;
    use crate::media::subtitles;

    /// Chinese subtitles tagged `jpn` — the exact mistake the automatic path
    /// exists to prevent. A tag-only check would accept this outright.
    fn mislabelled_chinese_srt() -> &'static str {
        "1\n00:00:01,000 --> 00:00:04,000\n早上好今天天气很好\n\n\
         2\n00:00:04,500 --> 00:00:08,000\n昨天我和朋友一起去看电影了\n\n\
         3\n00:00:08,500 --> 00:00:12,000\n真的很有趣我们明天再见吧\n\n\
         4\n00:00:12,500 --> 00:00:16,000\n你今天吃了什么好吃的东西吗\n\n\
         5\n00:00:16,500 --> 00:00:20,000\n我们下次一起去那家餐厅怎么样\n\n"
    }

    #[test]
    fn auto_selection_will_not_take_a_jpn_tagged_chinese_track() {
        let segments = subtitles::parse_srt(mislabelled_chinese_srt());
        assert!(!segments.is_empty(), "the SRT parser itself must not be the thing rejecting this");

        let outcome = subtitles::validate(&segments, 20.0);
        let err = outcome.expect_err("Chinese text must not pass Japanese validation");
        assert!(err.to_string().contains("Chinese"), "error should name the actual script: {err}");
    }

    /// But asking for that track *by name* now shows it. It is readable text
    /// in a language the user chose; only the breakdown is off the table.
    #[test]
    fn an_explicit_pick_of_a_chinese_track_is_allowed_to_display() {
        let segments = subtitles::parse_srt(mislabelled_chinese_srt());
        assert!(
            subtitles::check_dialogue(&segments, 20.0).is_ok(),
            "an explicit pick is only held to having dialogue in it"
        );
        assert_eq!(subtitles::detect_segments(&segments).script, Script::Chinese);
    }

    #[test]
    fn a_signs_track_is_refused_even_when_explicitly_picked() {
        // Nine captions across 24 minutes is not a transcript in any language,
        // and showing it as one would look like the app had simply failed.
        let segments = subtitles::parse_srt(
            "1\n00:00:01,000 --> 00:00:03,000\n東京\n\n2\n00:01:01,000 --> 00:01:03,000\n病院\n\n",
        );
        assert!(subtitles::check_dialogue(&segments, 1440.0).is_err());
    }

    #[test]
    fn detection_on_the_rejected_track_confirms_zero_kana() {
        let segments = subtitles::parse_srt(mislabelled_chinese_srt());
        let detection = subtitles::detect_segments(&segments);
        assert_eq!(detection.script, Script::Chinese);
        assert_eq!(detection.kana_ratio, 0.0);
        assert!(!detection.is_japanese());
    }
}

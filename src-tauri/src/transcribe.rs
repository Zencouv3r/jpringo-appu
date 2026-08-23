//! Running whisper.cpp over extracted audio.
//!
//! whisper-cli is invoked as a bundled sidecar rather than linked in-process.
//! That costs a process spawn per file — irrelevant next to a multi-minute
//! inference — and buys crash isolation: a bad model file or an unsupported
//! CPU feature takes down a child process instead of the whole app.

use std::path::Path;

use serde::Deserialize;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{AppError, Result};
use crate::model::Segment;
use crate::paths;
use crate::proc;
use crate::settings::Settings;

/// Sidecar name of the optional GPU-enabled whisper build.
const GPU_SIDECAR: &str = "whisper-cli-gpu";
const CPU_SIDECAR: &str = "whisper-cli";

/// whisper.cpp's `-oj` output. Only the fields we consume are modelled.
#[derive(Debug, Deserialize)]
struct WhisperOutput {
    #[serde(default)]
    transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperSegment {
    #[serde(default)]
    timestamps: WhisperTimestamps,
    #[serde(default)]
    offsets: WhisperOffsets,
    #[serde(default)]
    text: String,
}

#[derive(Debug, Default, Deserialize)]
struct WhisperTimestamps {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

/// Millisecond offsets. Preferred over `timestamps`, which are formatted
/// strings that lose precision.
#[derive(Debug, Default, Deserialize)]
struct WhisperOffsets {
    #[serde(default)]
    from: i64,
    #[serde(default)]
    to: i64,
}

/// Which whisper binary to use, given the user's preference and what is
/// actually installed.
///
/// `use_gpu` is a *preference*, not a guarantee — the GPU build is an optional
/// download. Falling back silently would leave the user wondering why nothing
/// got faster, so the mismatch is logged.
fn pick_binary(settings: &Settings) -> &'static str {
    if settings.use_gpu {
        if paths::has_sidecar(GPU_SIDECAR) {
            return GPU_SIDECAR;
        }
        log::info!(
            "GPU transcription is enabled but no `{GPU_SIDECAR}` sidecar is installed; \
             using the CPU build. Run scripts/fetch-sidecars.ps1 -Cuda to add it."
        );
    }
    CPU_SIDECAR
}

/// Transcribes a 16 kHz mono WAV.
///
/// `on_progress` receives 0-100 as whisper reports it. Progress comes from
/// parsing stderr because whisper-cli has no structured progress channel; the
/// format is stable enough that a missed line only costs a stalled progress
/// bar, never a failed run.
pub async fn transcribe<F>(
    app: &AppHandle,
    settings: &Settings,
    wav: &Path,
    model: &Path,
    mut on_progress: F,
) -> Result<Vec<Segment>>
where
    F: FnMut(u8) + Send + 'static,
{
    if !model.is_file() {
        return Err(AppError::MissingModel(format!(
            "Whisper model not found at {}. Set a valid path in Settings.",
            model.display()
        )));
    }

    let binary = pick_binary(settings);
    // Fail here, naming the folder, rather than part-way into the run with an
    // assertion from inside ggml. See `paths::ensure_compute_backends`.
    paths::ensure_compute_backends(binary)?;

    // whisper-cli writes `<output-file>.json`; it appends the extension itself,
    // so the argument is the path *without* one.
    let output_base = wav.with_extension("");
    let json_path = wav.with_extension("json");

    let mut cmd = proc::command(app, binary)?;
    cmd.arg("-m")
        .arg(model)
        .arg("-f")
        .arg(wav)
        .args(["-l", &settings.language])
        .args(["-t", &settings.whisper_threads.to_string()])
        .args([
            // Structured output, written next to the WAV.
            "-oj",
            // Progress on stderr for the UI.
            "-pp",
            // Suppress the model/system banner so stderr is just progress.
            "-np",
            // Cap segment length. whisper will otherwise emit 30-second
            // paragraphs, which are unusable as clickable subtitle lines and
            // far too coarse for per-line translation.
            "-ml",
            "60",
            // Prefer breaking between words rather than mid-token.
            "-sow",
        ])
        .arg("-of")
        .arg(&output_base);

    if binary == CPU_SIDECAR {
        // The CPU build has no GPU backend; passing -ng avoids a spurious
        // "failed to initialize GPU" line on stderr.
        cmd.arg("-ng");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Sidecar { tool: binary.into(), message: format!("could not start: {e}") })?;

    // stderr is consumed concurrently with the wait below. Letting it fill its
    // pipe buffer instead would deadlock the child partway through a long file.
    let stderr = child.stderr.take();
    let progress_task = tokio::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(percent) = parse_progress(&line) {
                    on_progress(percent);
                } else if !line.trim().is_empty() {
                    tail.push(line);
                    if tail.len() > 8 {
                        tail.remove(0);
                    }
                }
            }
        }
        tail
    });

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Sidecar { tool: binary.into(), message: e.to_string() })?;
    let tail = progress_task.await.unwrap_or_default();

    if !status.success() {
        return Err(AppError::Sidecar {
            tool: binary.into(),
            message: if tail.is_empty() {
                format!("exited with {status}")
            } else {
                tail.join("; ")
            },
        });
    }

    let raw = std::fs::read_to_string(&json_path).map_err(|e| AppError::Sidecar {
        tool: binary.into(),
        message: format!("produced no JSON output ({e})"),
    })?;
    // Best-effort cleanup; a leftover file in the scratch dir is harmless.
    let _ = std::fs::remove_file(&json_path);

    let parsed: WhisperOutput = serde_json::from_str(&raw)
        .map_err(|e| AppError::Other(format!("could not read whisper output: {e}")))?;

    Ok(to_segments(parsed))
}

/// Converts whisper output to segments, dropping the noise it emits on silence.
fn to_segments(output: WhisperOutput) -> Vec<Segment> {
    let mut segments = Vec::with_capacity(output.transcription.len());

    for raw in output.transcription {
        let text = raw.text.trim().to_string();
        if text.is_empty() || is_hallucination(&text) {
            continue;
        }

        // Offsets are milliseconds; the string timestamps are the fallback.
        let start = if raw.offsets.to > 0 || raw.offsets.from > 0 {
            raw.offsets.from as f64 / 1000.0
        } else {
            parse_hms(&raw.timestamps.from).unwrap_or(0.0)
        };
        let end = if raw.offsets.to > 0 {
            raw.offsets.to as f64 / 1000.0
        } else {
            parse_hms(&raw.timestamps.to).unwrap_or(start)
        };

        segments.push(Segment {
            id: segments.len(),
            start,
            end: end.max(start),
            text,
            tokens: Vec::new(),
            translation: String::new(),
            terms: Vec::new(),
        });
    }

    segments
}

/// Whisper emits stock phrases over silence and music — subtitle-corpus
/// artifacts baked into the training data. They are not in the audio, and
/// letting them through means paying to have a nonexistent line explained.
fn is_hallucination(text: &str) -> bool {
    const NOISE: &[&str] = &[
        "ご視聴ありがとうございました",
        "ご視聴ありがとうございます",
        "チャンネル登録お願いします",
        "おやすみなさい",
        "Thanks for watching!",
        "Thank you for watching",
        "字幕視聴ありがとうございました",
    ];

    let trimmed = text.trim().trim_matches(|c: char| c.is_ascii_punctuation() || c == '。');
    if NOISE.contains(&trimmed) {
        return true;
    }

    // A line that is one character repeated is a decoder loop, not speech.
    let mut chars = trimmed.chars();
    if let Some(first) = chars.next() {
        if trimmed.chars().count() > 8 && chars.all(|c| c == first) {
            return true;
        }
    }
    false
}

/// `whisper_print_progress_callback: progress = 45%`
fn parse_progress(line: &str) -> Option<u8> {
    let idx = line.find("progress =")?;
    let rest = line[idx + "progress =".len()..].trim();
    let value = rest.trim_end_matches('%').trim();
    value.parse::<f64>().ok().map(|v| v.clamp(0.0, 100.0) as u8)
}

/// `00:01:23.456` into seconds.
fn parse_hms(value: &str) -> Option<f64> {
    let normalized = value.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    match parts.as_slice() {
        [h, m, s] => Some(
            h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?,
        ),
        [m, s] => Some(m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_whisper_progress_lines() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress =  45%"),
            Some(45)
        );
        assert_eq!(parse_progress("progress = 100%"), Some(100));
        assert_eq!(parse_progress("loading model"), None);
    }

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_hms("00:01:23.500"), Some(83.5));
        assert_eq!(parse_hms("01:30.000"), Some(90.0));
    }

    #[test]
    fn filters_stock_hallucinations() {
        assert!(is_hallucination("ご視聴ありがとうございました"));
        assert!(is_hallucination("ああああああああああ"));
        assert!(!is_hallucination("今日はいい天気ですね"));
    }

    #[test]
    fn prefers_millisecond_offsets_over_formatted_timestamps() {
        let output = WhisperOutput {
            transcription: vec![WhisperSegment {
                timestamps: WhisperTimestamps { from: "00:00:00.000".into(), to: "00:00:09.000".into() },
                offsets: WhisperOffsets { from: 1500, to: 4250 },
                text: "  テスト  ".into(),
            }],
        };
        let segments = to_segments(output);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 1.5);
        assert_eq!(segments[0].end, 4.25);
        assert_eq!(segments[0].text, "テスト");
    }
}

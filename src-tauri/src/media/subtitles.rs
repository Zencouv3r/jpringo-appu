//! Reading an existing subtitle track instead of transcribing.
//!
//! When a file already carries Japanese subtitles they beat anything whisper
//! can produce: they are human-authored, correctly spelled, and already
//! segmented at line boundaries. This module gets them into the same
//! [`Segment`] shape the whisper path produces so the rest of the pipeline
//! cannot tell the difference.

use std::path::Path;

use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::language::{self, Detection};
use crate::model::Segment;
use crate::proc;

/// Pulls one subtitle stream out of a container and converts it to SRT.
///
/// ASS/SSA is converted rather than passed through: it carries positioning,
/// karaoke timing, and typesetting overlays that would otherwise end up in the
/// transcript as literal `{\pos(640,480)}` noise.
pub async fn extract_embedded(
    app: &AppHandle,
    video: &Path,
    stream_index: u32,
) -> Result<Vec<Segment>> {
    let mut cmd = proc::command(app, "ffmpeg")?;
    cmd.args(["-nostdin", "-v", "error", "-i"])
        .arg(video)
        // `0:<index>` addresses the absolute stream index reported by ffprobe,
        // not the nth subtitle stream — they differ whenever video and audio
        // streams come first, which is always.
        .args(["-map", &format!("0:{stream_index}")])
        .args(["-c:s", "srt", "-f", "srt", "pipe:1"]);

    let stdout = proc::run_capture(cmd, "ffmpeg").await?;
    let text = decode_text(&stdout);
    Ok(parse_srt(&text))
}

/// Reads a sidecar subtitle file from disk.
pub async fn read_external(app: &AppHandle, path: &Path) -> Result<Vec<Segment>> {
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // SRT parses directly; everything else round-trips through ffmpeg so the
    // ASS override-tag stripping is handled by a real parser rather than a
    // regex of ours.
    if extension == "srt" {
        let bytes = std::fs::read(path)?;
        return Ok(parse_srt(&decode_text(&bytes)));
    }

    let mut cmd = proc::command(app, "ffmpeg")?;
    cmd.args(["-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args(["-c:s", "srt", "-f", "srt", "pipe:1"]);

    let stdout = proc::run_capture(cmd, "ffmpeg").await?;
    Ok(parse_srt(&decode_text(&stdout)))
}

/// Decodes subtitle bytes to text.
///
/// Japanese subtitle files are frequently Shift-JIS rather than UTF-8, and a
/// lossy UTF-8 read turns every kanji into replacement characters. `encoding_rs`
/// sniffs the BOM; when there isn't one, invalid UTF-8 is retried as Shift-JIS.
fn decode_text(bytes: &[u8]) -> String {
    let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(bytes);
    if !had_errors {
        return decoded.into_owned();
    }
    let (sjis, _, sjis_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if sjis_errors {
        // Neither worked cleanly; UTF-8 with replacements is the safer of two
        // bad options since most of the file is probably fine.
        decoded.into_owned()
    } else {
        sjis.into_owned()
    }
}

/// Parses SRT into segments, dropping anything that would pollute the analysis.
pub fn parse_srt(text: &str) -> Vec<Segment> {
    let mut segments = Vec::new();

    // Blocks are separated by a blank line. `\r` is stripped up front so the
    // same code handles both line-ending conventions.
    for block in text.replace('\r', "").split("\n\n") {
        let lines: Vec<&str> = block.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if lines.is_empty() {
            continue;
        }

        // A leading pure-integer line is the sequence number; the timing line
        // is whichever line contains the arrow.
        let Some(timing_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let Some((start, end)) = parse_timing(lines[timing_idx]) else {
            continue;
        };

        let body = lines[timing_idx + 1..].join(" ");
        let text = clean_subtitle_text(&body);
        if text.is_empty() {
            continue;
        }

        segments.push(Segment {
            id: segments.len(),
            start,
            end,
            text,
            tokens: Vec::new(),
            translation: String::new(),
            terms: Vec::new(),
        });
    }

    segments
}

/// `00:01:23,456 --> 00:01:25,789` into a pair of second offsets.
fn parse_timing(line: &str) -> Option<(f64, f64)> {
    let (start, rest) = line.split_once("-->")?;
    // Trailing position overrides (`X1:0 X2:0 ...`) follow the end timestamp
    // in some files; splitting on whitespace discards them.
    let end = rest.split_whitespace().next()?;
    Some((parse_timestamp(start.trim())?, parse_timestamp(end.trim())?))
}

/// `HH:MM:SS,mmm` or `HH:MM:SS.mmm` into seconds.
fn parse_timestamp(value: &str) -> Option<f64> {
    let normalized = value.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [h, m, s] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        [m, s] => (0.0, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        _ => return None,
    };
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Strips markup and rejects lines that are not dialogue.
fn clean_subtitle_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth_angle = 0usize;
    let mut depth_brace = 0usize;

    // Hand-rolled rather than regex: subtitle markup nests (`{\an8}<i>text</i>`)
    // and a depth counter handles that in one pass.
    for ch in raw.chars() {
        match ch {
            '<' => depth_angle += 1,
            '>' => depth_angle = depth_angle.saturating_sub(1),
            '{' => depth_brace += 1,
            '}' => depth_brace = depth_brace.saturating_sub(1),
            _ if depth_angle == 0 && depth_brace == 0 => out.push(ch),
            _ => {}
        }
    }

    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");

    // Signs, song lyrics, and typesetting credits are not dialogue and only
    // add noise to a vocabulary breakdown.
    if cleaned.starts_with('♪') || cleaned.starts_with('♫') {
        return String::new();
    }
    cleaned
}

/// Rejects a subtitle track that parsed but is not usable as a transcript.
///
/// Two independent failure modes, both common enough to be worth guarding:
///
/// * **Forced/signs tracks** exist on many releases, are tagged `jpn`, and hold
///   a dozen location captions for a 24-minute episode.
/// * **Wrong-language tracks** — a `jpn` tag on Chinese subtitles is the
///   expensive one, because CJK ideographs look Japanese to any check that
///   doesn't insist on kana. See [`crate::language`].
///
/// Returning the detection lets the caller report *why* a track was rejected
/// rather than silently falling through to whisper.
pub fn validate(segments: &[Segment], duration: f64) -> Result<Detection> {
    check_dialogue(segments, duration)?;

    let detection = detect_segments(segments);
    if !detection.is_japanese() {
        return Err(AppError::NotFound(format!(
            "That subtitle track is {}, not Japanese.",
            detection.script.label()
        )));
    }

    Ok(detection)
}

/// The language-agnostic half of [`validate`]: is there dialogue here at all?
///
/// This is what an *explicit* track pick is held to. The user asking for the
/// Chinese track by name is not a mistake to protect them from — they get the
/// lines to read along with, minus the breakdown, which only Japanese supports.
/// The signs/forced guard still applies, because a track holding nine location
/// captions is not a transcript in any language.
pub fn check_dialogue(segments: &[Segment], duration: f64) -> Result<()> {
    if segments.is_empty() {
        return Err(AppError::NotFound(
            "That subtitle track has no readable dialogue.".into(),
        ));
    }

    // Fewer than two lines a minute is a signs-only or forced track.
    if duration > 120.0 {
        let per_minute = segments.len() as f64 / (duration / 60.0);
        if per_minute < 2.0 {
            return Err(AppError::NotFound(format!(
                "That subtitle track only has {} lines across {:.0} minutes — it looks like a \
                 signs/forced track rather than full dialogue.",
                segments.len(),
                duration / 60.0
            )));
        }
    }

    Ok(())
}

/// Runs script detection over a transcript's text.
pub fn detect_segments(segments: &[Segment]) -> Detection {
    language::detect_lines(segments.iter().map(|s| s.text.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_basic_cue() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nこんにちは\n\n";
        let segments = parse_srt(srt);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "こんにちは");
        assert_eq!(segments[0].start, 1.0);
        assert_eq!(segments[0].end, 3.5);
    }

    #[test]
    fn joins_multi_line_cues_and_strips_markup() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\n{\\an8}<i>おはよう</i>\nございます\n\n";
        let segments = parse_srt(srt);
        assert_eq!(segments[0].text, "おはよう ございます");
    }

    #[test]
    fn skips_music_cues_and_empty_blocks() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\n♪ ラララ ♪\n\n\
                   2\n00:00:04,000 --> 00:00:05,000\n本当に\n\n";
        let segments = parse_srt(srt);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "本当に");
        // IDs are assigned after filtering, so they stay contiguous from zero.
        assert_eq!(segments[0].id, 0);
    }

    #[test]
    fn rejects_a_forced_signs_track() {
        let segments = parse_srt("1\n00:00:01,000 --> 00:00:03,000\n東京\n\n");
        assert!(validate(&segments, 1440.0).is_err());
    }

    #[test]
    fn accepts_a_full_dialogue_track() {
        let mut srt = String::new();
        for i in 0..60 {
            srt.push_str(&format!(
                "{n}\n00:00:{s:02},000 --> 00:00:{e:02},000\nこれはテストです\n\n",
                n = i + 1,
                s = i % 60,
                e = (i + 1) % 60
            ));
        }
        let segments = parse_srt(&srt);
        assert!(validate(&segments, 600.0).is_ok());
    }
}

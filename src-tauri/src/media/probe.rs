//! Inspecting a video file with ffprobe.

use std::path::Path;

use serde::Deserialize;
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::model::{AudioTrack, Playback, SubtitleTrack, VideoInfo};
use crate::proc;

/// Container extensions WebView2 can demux on its own.
const WEB_CONTAINERS: &[&str] = &["mp4", "m4v", "webm", "ogv", "mov"];

/// Video codecs WebView2 can decode. HEVC is deliberately absent: playback
/// depends on an OS extension that may not be installed, and silently handing
/// the element something it cannot decode produces a black frame with no
/// error. Remuxing is the safe default.
const WEB_VIDEO_CODECS: &[&str] = &["h264", "vp8", "vp9", "av1"];

/// Audio codecs WebView2 can decode. Anime commonly ships FLAC, AC-3, or DTS,
/// none of which qualify — those need a transcode even when the video stream
/// could have been copied.
const WEB_AUDIO_CODECS: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac"];

/// Sidecar subtitle extensions looked for next to the video file.
const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt"];

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    #[serde(default)]
    format: FfprobeFormat,
}

#[derive(Debug, Default, Deserialize)]
struct FfprobeFormat {
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    format_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    index: u32,
    #[serde(default)]
    codec_name: Option<String>,
    #[serde(default)]
    codec_type: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    channels: Option<u32>,
    #[serde(default)]
    disposition: std::collections::HashMap<String, i32>,
    #[serde(default)]
    tags: std::collections::HashMap<String, String>,
}

impl FfprobeStream {
    fn flag(&self, key: &str) -> bool {
        self.disposition.get(key).is_some_and(|v| *v != 0)
    }

    fn tag(&self, key: &str) -> Option<String> {
        // Tag keys vary in case across muxers (`language` vs `LANGUAGE`).
        self.tags
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

/// Runs ffprobe and turns its JSON into a [`VideoInfo`].
///
/// `id` is supplied by the caller rather than computed here because hashing
/// the file is comparatively slow and the caller usually already has it.
pub async fn probe(app: &AppHandle, path: &Path, id: String) -> Result<VideoInfo> {
    if !path.is_file() {
        return Err(AppError::NotFound(format!(
            "{} no longer exists.",
            path.display()
        )));
    }

    let mut cmd = proc::command(app, "ffprobe")?;
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(path);

    let stdout = proc::run_capture(cmd, "ffprobe").await?;
    let probed: FfprobeOutput = serde_json::from_slice(&stdout)
        .map_err(|e| AppError::Other(format!("could not read ffprobe output: {e}")))?;

    let video = probed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = probed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let audio_tracks: Vec<AudioTrack> = probed
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| AudioTrack {
            index: s.index,
            codec: s.codec_name.clone().unwrap_or_default(),
            language: s.tag("language").map(|l| l.to_lowercase()),
            title: s.tag("title"),
            channels: s.channels,
            default: s.flag("default"),
        })
        .collect();

    let subtitle_tracks: Vec<SubtitleTrack> = probed
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("subtitle"))
        .map(|s| {
            let codec = s.codec_name.clone().unwrap_or_default();
            SubtitleTrack {
                textual: !is_bitmap_subtitle(&codec),
                index: s.index,
                codec,
                language: s.tag("language").map(|l| l.to_lowercase()),
                title: s.tag("title"),
                default: s.flag("default"),
                forced: s.flag("forced"),
            }
        })
        .collect();

    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let container = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let video_codec = video.and_then(|s| s.codec_name.clone());
    let audio_codec = audio.and_then(|s| s.codec_name.clone());

    let playback = if is_web_native(&container, video_codec.as_deref(), audio_codec.as_deref()) {
        Playback::Direct
    } else {
        Playback::Remux
    };

    Ok(VideoInfo {
        id,
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        duration: probed
            .format
            .duration
            .and_then(|d| d.parse::<f64>().ok())
            .unwrap_or(0.0),
        container: probed.format.format_name.unwrap_or(container),
        video_codec,
        audio_codec,
        width: video.and_then(|s| s.width),
        height: video.and_then(|s| s.height),
        size_bytes,
        audio_tracks,
        subtitle_tracks,
        external_subtitles: find_external_subtitles(path),
        playback,
        // Filled in by the caller, which owns the cache.
        has_analysis: false,
    })
}

/// Whether the browser can play this file as-is. All three of container, video
/// codec, and audio codec have to qualify — a FLAC track in an MP4 is enough
/// to make the whole file unplayable.
fn is_web_native(container: &str, video: Option<&str>, audio: Option<&str>) -> bool {
    if !WEB_CONTAINERS.contains(&container) {
        return false;
    }
    // FLAC-in-MP4 is not supported even though FLAC-in-WebM is.
    if container != "webm" && audio == Some("flac") {
        return false;
    }
    let video_ok = video.is_none_or(|c| WEB_VIDEO_CODECS.contains(&c));
    let audio_ok = audio.is_none_or(|c| WEB_AUDIO_CODECS.contains(&c));
    video_ok && audio_ok
}

/// Finds sibling subtitle files: exactly `<stem>.srt`, or the common
/// `<stem>.ja.srt` / `<stem>.jpn.ass` language-suffixed variants.
fn find_external_subtitles(video: &Path) -> Vec<String> {
    let Some(dir) = video.parent() else {
        return Vec::new();
    };
    let Some(stem) = video.file_stem().map(|s| s.to_string_lossy().to_lowercase()) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut found: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let Some(ext) = p.extension().map(|e| e.to_string_lossy().to_lowercase()) else {
                return false;
            };
            if !SUBTITLE_EXTENSIONS.contains(&ext.as_str()) {
                return false;
            }
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                // `starts_with` rather than equality so `ep01.ja.srt` matches
                // `ep01.mkv`; the trailing part is a language tag.
                .is_some_and(|s| s == stem || s.starts_with(&format!("{stem}.")))
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    found.sort();
    found
}

/// Bitmap subtitle codecs, which carry pixels rather than text.
fn is_bitmap_subtitle(codec: &str) -> bool {
    matches!(
        codec,
        "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub" | "dvbsub"
    )
}

/// Orders subtitle tracks by how likely each is to be the Japanese dialogue.
///
/// This only *ranks* — it never decides. The container tag is a hint, not
/// evidence: tracks go missing tags, carry wrong ones, and get labelled `jpn`
/// while containing nothing but sign translations. The caller extracts
/// candidates in this order and lets [`crate::language::detect`] rule on the
/// actual text, which is the only thing that can tell Japanese from Chinese.
///
/// Returned indices are absolute ffprobe stream indices.
pub fn rank_subtitle_candidates(tracks: &[SubtitleTrack]) -> Vec<u32> {
    let mut ranked: Vec<&SubtitleTrack> = tracks
        .iter()
        // Bitmap tracks have no text to extract at all, so they are excluded
        // rather than ranked low.
        .filter(|t| t.textual)
        .collect();

    ranked.sort_by_key(|track| {
        let language = track.language.as_deref().unwrap_or("");
        let is_japanese_tag = language.starts_with("ja") || language.starts_with("jp");
        // An untagged track outranks one tagged as another language: unknown
        // is worth testing, known-wrong is not.
        let untagged = language.is_empty();

        let tag_rank = if is_japanese_tag {
            0
        } else if untagged {
            1
        } else {
            2
        };

        // A track whose title says "signs" or "forced" is dialogue-poor even
        // when its language tag is right.
        let signs = track.forced || mentions_signs(track.title.as_deref());

        (tag_rank, signs as u8, !track.default as u8, track.index)
    });

    ranked.into_iter().map(|t| t.index).collect()
}

/// Title conventions releases use for signs-and-songs tracks.
fn mentions_signs(title: Option<&str>) -> bool {
    let Some(title) = title else {
        return false;
    };
    let lower = title.to_lowercase();
    ["sign", "song", "forced", "commentary", "karaoke"]
        .iter()
        .any(|needle| lower.contains(needle))
}


/// Orders audio tracks by how likely each is to be Japanese, for whisper to
/// transcribe.
///
/// Unlike subtitle selection this never validates by content — you cannot run
/// script detection on a waveform — so the language tag is all there is to go
/// on. Getting it wrong is exactly why this exists at all: without it, ffmpeg
/// silently picks its own default stream, and a file whose default track is an
/// English dub gets fed to whisper with `-l ja` forced, producing fluent
/// nonsense with no error anywhere.
///
/// Returned indices are absolute ffprobe stream indices.
pub fn rank_audio_candidates(tracks: &[AudioTrack]) -> Vec<u32> {
    let mut ranked: Vec<&AudioTrack> = tracks.iter().collect();

    ranked.sort_by_key(|track| {
        let language = track.language.as_deref().unwrap_or("");
        let is_japanese_tag = language.starts_with("ja") || language.starts_with("jp");
        let untagged = language.is_empty();

        let tag_rank = if is_japanese_tag {
            0
        } else if untagged {
            1
        } else {
            2
        };

        (tag_rank, !track.default as u8, track.index)
    });

    ranked.into_iter().map(|t| t.index).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(index: u32, language: Option<&str>, title: Option<&str>) -> SubtitleTrack {
        SubtitleTrack {
            index,
            codec: "subrip".into(),
            language: language.map(str::to_string),
            title: title.map(str::to_string),
            default: false,
            forced: false,
            textual: true,
        }
    }

    fn audio(index: u32, language: Option<&str>, default: bool) -> AudioTrack {
        AudioTrack {
            index,
            codec: "aac".into(),
            language: language.map(str::to_string),
            title: None,
            channels: Some(2),
            default,
        }
    }

    #[test]
    fn japanese_tagged_audio_is_preferred_for_transcription() {
        // The default track is the English dub; the Japanese original is
        // second. Blindly transcribing ffmpeg's default would feed English
        // audio into a whisper run pinned to -l ja.
        let tracks = vec![
            audio(2, Some("eng"), true),
            audio(3, Some("jpn"), false),
        ];
        assert_eq!(rank_audio_candidates(&tracks).first(), Some(&3));
    }

    #[test]
    fn untagged_audio_beats_a_known_other_language() {
        let tracks = vec![audio(2, Some("eng"), false), audio(3, None, false)];
        assert_eq!(rank_audio_candidates(&tracks), vec![3, 2]);
    }

    #[test]
    fn default_flag_breaks_ties_between_equally_tagged_tracks() {
        let tracks = vec![audio(2, Some("jpn"), false), audio(3, Some("jpn"), true)];
        assert_eq!(rank_audio_candidates(&tracks).first(), Some(&3));
    }

    #[test]
    fn japanese_tagged_tracks_are_tried_first() {
        let tracks = vec![
            track(2, Some("eng"), None),
            track(3, Some("jpn"), None),
            track(4, Some("spa"), None),
        ];
        assert_eq!(rank_subtitle_candidates(&tracks).first(), Some(&3));
    }

    #[test]
    fn untagged_beats_a_known_other_language() {
        // Unknown is worth testing against the text; known-wrong is not.
        let tracks = vec![track(2, Some("eng"), None), track(3, None, None)];
        assert_eq!(rank_subtitle_candidates(&tracks), vec![3, 2]);
    }

    #[test]
    fn signs_tracks_sink_below_full_dialogue() {
        let mut signs = track(2, Some("jpn"), Some("Signs & Songs"));
        signs.forced = true;
        let tracks = vec![signs, track(3, Some("jpn"), Some("Full Subtitles"))];
        assert_eq!(rank_subtitle_candidates(&tracks), vec![3, 2]);
    }

    #[test]
    fn bitmap_tracks_are_excluded_entirely() {
        let mut pgs = track(2, Some("jpn"), None);
        pgs.codec = "hdmv_pgs_subtitle".into();
        pgs.textual = false;
        let tracks = vec![pgs, track(3, Some("eng"), None)];
        assert_eq!(rank_subtitle_candidates(&tracks), vec![3]);
    }

    #[test]
    fn every_textual_track_stays_a_candidate() {
        // Even a Chinese-tagged track is returned - detection rejects it on
        // content, and a wrong tag on a Japanese track shouldn't lose it.
        let tracks = vec![track(2, Some("chi"), None), track(3, Some("eng"), None)];
        assert_eq!(rank_subtitle_candidates(&tracks).len(), 2);
    }

    #[test]
    fn web_native_detection_rejects_mkv_and_exotic_audio() {
        assert!(is_web_native("mp4", Some("h264"), Some("aac")));
        assert!(!is_web_native("mkv", Some("h264"), Some("aac")));
        // FLAC plays in WebM but not in MP4.
        assert!(!is_web_native("mp4", Some("h264"), Some("flac")));
        assert!(is_web_native("webm", Some("vp9"), Some("opus")));
        // HEVC needs an OS codec extension that may not be present.
        assert!(!is_web_native("mp4", Some("hevc"), Some("aac")));
    }
}

#[cfg(test)]
mod real_file_tests {
    //! Runs the actual bundled ffprobe against a real multi-track MKV built for
    //! this session, rather than trusting that the JSON shapes in the unit
    //! tests above match what ffprobe truly emits. ffprobe is invoked directly
    //! (not through proc::command, which needs an AppHandle this test has
    //! no way to construct) against the sidecar binary checked into the repo.
    //!
    //! Ignored by default since it depends on a scratch file that only exists
    //! on this development machine; run explicitly with
    //! `RINGO_TEST_MULTI_MKV=... cargo test -- --ignored`.
    use super::*;
    use std::process::Command;

    fn probe_file(path: &std::path::Path) -> FfprobeOutput {
        let ffprobe = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("ffprobe-{}.exe", env!("RINGO_TARGET_TRIPLE")));
        let output = Command::new(ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(path)
            .output()
            .expect("ffprobe sidecar should run");
        assert!(output.status.success(), "ffprobe failed: {}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).expect("ffprobe should emit valid JSON")
    }

    fn scratch_mkv() -> std::path::PathBuf {
        std::path::PathBuf::from(
            std::env::var("RINGO_TEST_MULTI_MKV")
                .expect("set RINGO_TEST_MULTI_MKV to the multi-track test file"),
        )
    }

    #[test]
    #[ignore]
    fn ranks_the_japanese_audio_track_first_despite_english_being_default() {
        let probed = probe_file(&scratch_mkv());
        let audio_tracks: Vec<AudioTrack> = probed
            .streams
            .iter()
            .filter(|s| s.codec_type.as_deref() == Some("audio"))
            .map(|s| AudioTrack {
                index: s.index,
                codec: s.codec_name.clone().unwrap_or_default(),
                language: s.tag("language").map(|l| l.to_lowercase()),
                title: s.tag("title"),
                channels: s.channels,
                default: s.flag("default"),
            })
            .collect();

        assert_eq!(audio_tracks.len(), 2, "expected the eng+jpn multi-track fixture");
        let ranked = rank_audio_candidates(&audio_tracks);
        assert_eq!(
            ranked.first(),
            Some(&2),
            "jpn-tagged stream 2 must outrank the default eng track (real ffprobe output: {audio_tracks:?})"
        );
    }

    #[test]
    #[ignore]
    fn ranks_the_japanese_subtitle_track_first() {
        let probed = probe_file(&scratch_mkv());
        let subtitle_tracks: Vec<SubtitleTrack> = probed
            .streams
            .iter()
            .filter(|s| s.codec_type.as_deref() == Some("subtitle"))
            .map(|s| {
                let codec = s.codec_name.clone().unwrap_or_default();
                SubtitleTrack {
                    textual: !is_bitmap_subtitle(&codec),
                    index: s.index,
                    codec,
                    language: s.tag("language").map(|l| l.to_lowercase()),
                    title: s.tag("title"),
                    default: s.flag("default"),
                    forced: s.flag("forced"),
                }
            })
            .collect();

        assert_eq!(subtitle_tracks.len(), 2, "expected the eng+jpn multi-track fixture");
        let ranked = rank_subtitle_candidates(&subtitle_tracks);
        assert_eq!(
            ranked.first(),
            Some(&4),
            "the jpn-tagged subtitle stream must be tried first (real ffprobe output: {subtitle_tracks:?})"
        );
    }
}

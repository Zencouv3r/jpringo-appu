//! Extracting whisper-ready audio from a video file.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::error::Result;
use crate::proc;

/// Decodes the primary audio track to the only format whisper.cpp accepts:
/// 16 kHz, mono, signed 16-bit PCM.
///
/// This is a full decode-and-resample, not a copy, so it is the slowest part
/// of the pipeline that is not the model itself — roughly real-time over 1/20th
/// for a typical episode.
///
/// `-vn`/`-sn`/`-dn` drop the video, subtitle, and data streams explicitly.
/// Without them ffmpeg will happily spend time decoding video frames it is
/// about to discard.
pub async fn extract_wav(
    app: &AppHandle,
    video: &Path,
    audio_track: Option<u32>,
    dest: &Path,
) -> Result<PathBuf> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut cmd = proc::command(app, "ffmpeg")?;
    cmd.args(["-nostdin", "-v", "error", "-y", "-i"]).arg(video);

    // Without an explicit -map, ffmpeg picks its own default audio stream,
    // which is not necessarily the Japanese one on a multi-track file — see
    // probe::rank_audio_candidates, which is what should have produced this
    // index.
    match audio_track {
        Some(index) => { cmd.args(["-map", &format!("0:{index}")]); }
        None => { cmd.args(["-map", "0:a:0?"]); }
    }

    cmd.args([
        "-vn", "-sn", "-dn", // audio only
        "-ac", "1", // mono
        "-ar", "16000", // 16 kHz
        "-c:a", "pcm_s16le", "-f", "wav",
    ])
    .arg(dest);

    proc::run_capture(cmd, "ffmpeg").await?;
    Ok(dest.to_path_buf())
}

/// Remuxes into a fragmented MP4 that WebView2 can play.
///
/// Streams are copied when they are already web-compatible and transcoded only
/// when they are not, which is why this usually finishes far faster than
/// real time. `+faststart` is deliberately absent — it requires a second pass
/// over the output, and the caller wants bytes flowing immediately.
///
/// `audio_track` is the absolute ffprobe stream index to mux in, or `None` for
/// the container's first. It is a parameter because WebView2 exposes no
/// `audioTracks` API: the only way to let the user change audio track is to
/// hand the player a stream that already contains the one they picked.
///
/// Returns the [`tokio::process::Command`] rather than running it so callers
/// can choose between piping it to a socket and writing it to the cache.
pub fn remux_command(
    app: &AppHandle,
    video: &Path,
    start: f64,
    video_codec: Option<&str>,
    audio_codec: Option<&str>,
    audio_track: Option<u32>,
    dest: Option<&Path>,
) -> Result<tokio::process::Command> {
    let mut cmd = proc::command(app, "ffmpeg")?;
    cmd.args(["-nostdin", "-v", "error"]);

    // Placing -ss before -i makes ffmpeg seek the input rather than decode and
    // discard, which is the difference between a seek costing 0.2s and 30s.
    if start > 0.0 {
        cmd.args(["-ss", &format!("{start:.3}")]);
    }
    cmd.arg("-i").arg(video);

    // One video stream and one audio stream. Anime files routinely carry five
    // audio tracks and a dozen subtitle tracks; muxing them all in is wasted
    // bandwidth the player will never use.
    cmd.args(["-map", "0:v:0"]);
    match audio_track {
        Some(index) => cmd.args(["-map", &format!("0:{index}")]),
        None => cmd.args(["-map", "0:a:0?"]),
    };
    cmd.args(["-sn", "-dn"]);

    if video_codec.is_some_and(|c| c == "h264") {
        cmd.args(["-c:v", "copy"]);
    } else {
        // veryfast/CRF 23 keeps a 1080p transcode near real time on a mid CPU,
        // which is the floor for this to feel like streaming rather than
        // converting.
        cmd.args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        ]);
    }

    if audio_codec.is_some_and(|c| matches!(c, "aac" | "mp3")) {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
    }

    match dest {
        // Writing to a file: a normal MP4 with the index at the front, so the
        // finished artifact supports exact range-request seeking.
        Some(path) => {
            cmd.args(["-movflags", "+faststart", "-f", "mp4", "-y"]).arg(path);
        }
        // Streaming to a pipe: fragmented MP4, because a plain MP4 cannot be
        // written to a non-seekable output — its index is only known at the end.
        None => {
            cmd.args([
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "pipe:1",
            ]);
        }
    }

    Ok(cmd)
}

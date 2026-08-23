//! A loopback HTTP server that feeds the `<video>` element.
//!
//! Tauri can expose local files through the `asset:` protocol, but that only
//! helps for files the webview can already demux. MKV — the container almost
//! every anime release uses — has no demuxer in WebView2 at all, so those
//! files have to go through ffmpeg. Serving over HTTP rather than through a
//! custom protocol handler is what buys us working range requests, and range
//! requests are what make seeking in a 1.4 GB file instant.
//!
//! Two routes, picked per file by [`crate::model::Playback`]:
//!
//! * `GET /media/{id}` — byte-exact serving of a real file on disk, with range
//!   support. Used for web-native files, and for remuxed ones once their
//!   cached MP4 has finished building.
//! * `GET /media/{id}/stream?t=` — a live fragmented-MP4 pipe out of ffmpeg.
//!   Starts instantly and cannot be range-seeked, so the frontend seeks by
//!   reopening the URL at a new `t`.
//!
//! Only ids handed out by [`MediaRegistry::register`] resolve, and every
//! request must carry the session token, so this cannot be used by another
//! process on the machine to read arbitrary files.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::RwLock;

use crate::error::{AppError, Result};
use crate::media::audio;
use crate::model::{audio_codec_of, AudioTrack, Playback};

/// One file the player is allowed to fetch.
#[derive(Debug, Clone)]
pub struct MediaEntry {
    pub path: PathBuf,
    pub playback: Playback,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    /// Every audio stream in the file, so the codec of a *switched-to* track is
    /// known without re-probing — `audio_codec` only describes the first one.
    pub audio_tracks: Vec<AudioTrack>,
    /// Set once a background remux has produced a seekable MP4 *for the
    /// currently selected audio track*. Its presence is what lets a `Remux`
    /// file graduate to exact seeking.
    pub remuxed: Option<PathBuf>,
    /// Absolute stream index of the audio track the user picked, or `None` for
    /// the container's first.
    pub audio_track: Option<u32>,
}

impl MediaEntry {
    /// Whether this file can currently be served as seekable bytes.
    ///
    /// A `Direct` file qualifies only while the default audio track is
    /// selected: switching tracks means ffmpeg has to build the stream, since
    /// WebView2 offers no way to choose one client-side.
    pub fn is_exact(&self) -> bool {
        if self.remuxed.is_some() {
            return true;
        }
        self.playback == Playback::Direct && self.audio_track.is_none()
    }

    /// Codec of the audio stream a remux of this entry would carry.
    pub fn selected_audio_codec(&self, audio_track: Option<u32>) -> Option<&str> {
        audio_codec_of(&self.audio_tracks, audio_track, self.audio_codec.as_deref())
    }
}

#[derive(Clone)]
pub struct MediaRegistry {
    app: AppHandle,
    entries: Arc<RwLock<HashMap<String, MediaEntry>>>,
    /// Random per-launch secret. Requests without it are refused, so another
    /// local process cannot enumerate ids and pull video out of the server.
    token: Arc<String>,
    port: Arc<RwLock<Option<u16>>>,
}

impl MediaRegistry {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            entries: Arc::new(RwLock::new(HashMap::new())),
            token: Arc::new(random_token()),
            port: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn register(&self, id: String, entry: MediaEntry) {
        self.entries.write().await.insert(id, entry);
    }

    pub async fn get(&self, id: &str) -> Option<MediaEntry> {
        self.entries.read().await.get(id).cloned()
    }

    /// Records that a background remux finished, so subsequent requests get
    /// the seekable file instead of a live pipe.
    ///
    /// `audio_track` guards against a late-finishing remux for a track the user
    /// has already switched away from being adopted as the current source.
    pub async fn set_remuxed(&self, id: &str, audio_track: Option<u32>, path: PathBuf) {
        if let Some(entry) = self.entries.write().await.get_mut(id) {
            if entry.audio_track == audio_track {
                entry.remuxed = Some(path);
            }
        }
    }

    /// Switches audio track, dropping any remux built for the previous one.
    pub async fn set_audio_track(&self, id: &str, audio_track: Option<u32>) -> Option<MediaEntry> {
        let mut entries = self.entries.write().await;
        let entry = entries.get_mut(id)?;
        if entry.audio_track != audio_track {
            entry.audio_track = audio_track;
            entry.remuxed = None;
        }
        Some(entry.clone())
    }

    async fn port(&self) -> Option<u16> {
        *self.port.read().await
    }

    /// URL for the player to use, or `None` before the server is listening.
    ///
    /// The audio track rides in the query string rather than in server state so
    /// that switching tracks changes the URL — which is what makes the `<video>`
    /// element reload instead of continuing on the old stream.
    pub async fn url_for(&self, id: &str, entry: &MediaEntry) -> Option<String> {
        let port = self.port().await?;
        let token = &self.token;
        // Carried on both routes. `serve_file` ignores it — it serves whichever
        // remux the entry currently points at — but without it, switching back
        // to a track whose remux is already cached would produce a URL byte-for
        // -byte identical to the one already loaded, and the element would go
        // on playing the previous track's audio rather than reloading.
        let audio = entry
            .audio_track
            .map(|i| format!("&a={i}"))
            .unwrap_or_default();
        Some(if entry.is_exact() {
            format!("http://127.0.0.1:{port}/media/{id}?token={token}{audio}")
        } else {
            format!("http://127.0.0.1:{port}/media/{id}/stream?token={token}{audio}")
        })
    }

    /// Binds to an ephemeral loopback port and serves until the app exits.
    pub async fn serve(&self) -> Result<u16> {
        let router = Router::new()
            .route("/media/{id}", get(serve_file))
            .route("/media/{id}/stream", get(serve_stream))
            .with_state(self.clone());

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| AppError::Io(format!("could not start the media server: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::Io(e.to_string()))?
            .port();
        *self.port.write().await = Some(port);

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, router).await {
                log::error!("media server stopped: {err}");
            }
        });

        log::info!("media server listening on 127.0.0.1:{port}");
        Ok(port)
    }
}

/// Bytes of entropy behind the session token. 128 bits is past the point
/// where guessing is worth anyone's time.
const TOKEN_BYTES: usize = 16;

fn random_token() -> String {
    // From the OS CSPRNG, not from a hashed timestamp. The earlier version
    // mixed `SystemTime::now()`, a thread id, and the process id — every one
    // of which another process on the machine can observe or guess, and two of
    // which have only a few thousand plausible values. That matters because
    // `add_common_headers` allows any origin: a page in the user's browser can
    // reach this server, and the token is the only thing standing between it
    // and the file being played.
    //
    // `getrandom` fails only if the OS has no entropy source at all, which on
    // a running desktop it does not. Falling back to a guessable token would
    // be worse than refusing to serve, so the failure is loud.
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("the OS random number generator is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares two tokens without leaking where they first differ.
///
/// The server is loopback-only, so a timing oracle here is a stretch — but the
/// comparison is sixteen bytes long and this costs nothing.
fn token_matches(expected: &str, offered: &str) -> bool {
    if expected.len() != offered.len() {
        return false;
    }
    expected
        .bytes()
        .zip(offered.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

#[derive(Debug, Deserialize)]
struct MediaQuery {
    token: Option<String>,
    /// Seconds to start the live stream at.
    #[serde(default)]
    t: Option<f64>,
    /// Absolute stream index of the audio track to mux in.
    #[serde(default)]
    a: Option<u32>,
}

/// Resolves and authorises a request, or returns the status to reply with.
async fn resolve(
    registry: &MediaRegistry,
    id: &str,
    query: &MediaQuery,
) -> std::result::Result<MediaEntry, StatusCode> {
    let offered = query.token.as_deref().unwrap_or_default();
    if !token_matches(&registry.token, offered) {
        return Err(StatusCode::FORBIDDEN);
    }
    registry.get(id).await.ok_or(StatusCode::NOT_FOUND)
}

/// Serves a real file with range support.
async fn serve_file(
    State(registry): State<MediaRegistry>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> std::result::Result<Response, StatusCode> {
    let entry = resolve(&registry, &id, &query).await?;

    // Prefer the remuxed copy when one exists — for a `Remux` file the
    // original is not something the browser can decode.
    let path = entry.remuxed.clone().unwrap_or_else(|| entry.path.clone());

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let total = file
        .metadata()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .len();

    let content_type = content_type_for(&path);

    match parse_range(&headers, total) {
        Some(None) => {
            // A syntactically valid header that no part of the file satisfies.
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            let h = response.headers_mut();
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
            );
            add_common_headers(h);
            Ok(response)
        }
        Some(Some((start, end))) => {
            let length = end - start + 1;
            let mut file = file;
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let stream = tokio_util::io::ReaderStream::new(file.take(length));

            let mut response = Response::new(Body::from_stream(stream));
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            let h = response.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&length.to_string()).unwrap(),
            );
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
            );
            add_common_headers(h);
            Ok(response)
        }
        None => {
            let stream = tokio_util::io::ReaderStream::new(file);
            let mut response = Response::new(Body::from_stream(stream));
            let h = response.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&total.to_string()).unwrap(),
            );
            add_common_headers(h);
            Ok(response)
        }
    }
}

/// Pipes a live ffmpeg remux to the player.
///
/// The response has no `Content-Length` and does not accept ranges: the length
/// genuinely is not known, because ffmpeg is still producing it. The frontend
/// compensates by treating `?t=` as the seek mechanism.
async fn serve_stream(
    State(registry): State<MediaRegistry>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<MediaQuery>,
) -> std::result::Result<Response, StatusCode> {
    let entry = resolve(&registry, &id, &query).await?;
    let start = query.t.unwrap_or(0.0).max(0.0);
    // The URL wins over stored state: a request already in flight when the user
    // switched tracks should finish serving what it was asked for.
    let audio_track = query.a.or(entry.audio_track);

    let mut cmd = audio::remux_command(
        &registry.app,
        &entry.path,
        start,
        entry.video_codec.as_deref(),
        entry.selected_audio_codec(audio_track),
        audio_track,
        None,
    )
    .map_err(|err| {
        log::error!("could not build remux command: {err}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let mut child = cmd.spawn().map_err(|err| {
        log::error!("could not start ffmpeg: {err}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let stdout = child.stdout.take().ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    // The child is carried in the stream's state, not dropped here. Combined
    // with `kill_on_drop`, that means closing the response — which is exactly
    // what the browser does on seek or navigation — kills ffmpeg instead of
    // leaving it transcoding into a pipe nobody reads.
    let stream = futures::stream::unfold((child, stdout), |(child, mut stdout)| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match stdout.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(buf), (child, stdout)))
            }
            Err(err) => {
                log::debug!("remux stream ended: {err}");
                None
            }
        }
    });

    let mut response = Response::new(Body::from_stream(stream));
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    // Explicitly *not* `bytes` — advertising range support on a stream that
    // cannot honour it makes the player issue ranged requests and stall.
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("none"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    add_common_headers(h);
    Ok(response)
}

fn add_common_headers(headers: &mut HeaderMap) {
    // The webview runs on a `tauri.localhost` origin, so every media request is
    // cross-origin to this loopback server.
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
}

fn content_type_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("ogv") => "video/ogg",
        _ => "video/mp4",
    }
}

/// Parses a `Range` header.
///
/// Returns `None` when absent (send the whole file), `Some(None)` when it is
/// unsatisfiable, and `Some(Some((start, end)))` for an inclusive byte range.
/// Only the single-range form is handled — it is the only one browsers send
/// for media playback.
fn parse_range(headers: &HeaderMap, total: u64) -> Option<Option<(u64, u64)>> {
    let raw = headers.get(header::RANGE)?.to_str().ok()?;
    let spec = raw.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return Some(None);
    }
    let (start_raw, end_raw) = spec.split_once('-')?;

    let range = if start_raw.is_empty() {
        // `bytes=-N`: the final N bytes.
        let n: u64 = end_raw.parse().ok()?;
        if n == 0 || total == 0 {
            return Some(None);
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let start: u64 = start_raw.parse().ok()?;
        let end = if end_raw.is_empty() {
            total.saturating_sub(1)
        } else {
            end_raw.parse::<u64>().ok()?.min(total.saturating_sub(1))
        };
        (start, end)
    };

    if total == 0 || range.0 >= total || range.0 > range.1 {
        return Some(None);
    }
    Some(Some(range))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_with(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::RANGE, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn absent_range_means_whole_file() {
        assert_eq!(parse_range(&HeaderMap::new(), 100), None);
    }

    #[test]
    fn parses_a_closed_range() {
        assert_eq!(parse_range(&header_with("bytes=0-49"), 100), Some(Some((0, 49))));
    }

    #[test]
    fn open_ended_range_runs_to_the_last_byte() {
        assert_eq!(parse_range(&header_with("bytes=50-"), 100), Some(Some((50, 99))));
    }

    #[test]
    fn suffix_range_counts_back_from_the_end() {
        assert_eq!(parse_range(&header_with("bytes=-20"), 100), Some(Some((80, 99))));
    }

    #[test]
    fn end_past_eof_is_clamped_rather_than_rejected() {
        assert_eq!(parse_range(&header_with("bytes=90-999"), 100), Some(Some((90, 99))));
    }

    #[test]
    fn start_past_eof_is_unsatisfiable() {
        assert_eq!(parse_range(&header_with("bytes=100-"), 100), Some(None));
    }

    #[test]
    fn multi_range_is_refused_rather_than_half_honoured() {
        assert_eq!(parse_range(&header_with("bytes=0-10,20-30"), 100), Some(None));
    }

    #[test]
    fn two_tokens_from_one_process_still_differ() {
        // The point of the CSPRNG: the previous implementation hashed the
        // clock and the process id, so two tokens minted in the same
        // millisecond by the same process were identical.
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn a_token_matches_only_itself() {
        let token = random_token();
        assert!(token_matches(&token, &token));
        assert!(!token_matches(&token, ""));
        assert!(!token_matches(&token, &token[..token.len() - 1]));

        // A near miss in the last byte must not pass — the fold has to reduce
        // the whole string, not stop at the first difference.
        let mut near = token.clone();
        near.pop();
        near.push(if token.ends_with('0') { '1' } else { '0' });
        assert!(!token_matches(&token, &near));
    }
}

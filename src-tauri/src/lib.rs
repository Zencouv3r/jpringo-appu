//! Ringo — Japanese subtitle generation and vocabulary breakdown for local
//! video files.
//!
//! Module map:
//!
//! * [`media`] — ffprobe/ffmpeg wrappers and the loopback server that feeds the
//!   `<video>` element.
//! * [`transcribe`] — whisper.cpp.
//! * [`analyze`] — Lindera tokenization, the dictionary lookup, and the
//!   in-context breakdown pass.
//! * [`vocab`] — the vocabulary log: cached word senses plus every encounter.
//! * [`anki`] — turning that log into flashcards.
//! * [`furigana`] — aligning a word with its reading, which both the flashcard
//!   export and the kanji screen read in their own way.
//! * [`language`] — script detection, so a mislabelled subtitle track never
//!   reaches the paid breakdown pass.
//! * [`pipeline`] — the sequence that turns a file into an [`model::Analysis`].
//! * [`commands`] — the IPC surface, mirrored by `src/lib/ipc.ts`.

mod analyze;
mod anki;
mod cache;
mod commands;
mod error;
mod furigana;
mod language;
mod library;
mod media;
mod model;
mod paths;
mod pipeline;
mod proc;
mod settings;
mod transcribe;
mod vocab;

use std::collections::HashMap;
use std::sync::Arc;

use tauri::Manager;
use tokio::sync::Mutex;

use commands::AppState;
use media::server::MediaRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Before anything reads or writes: an install upgraded from a
            // build that kept everything under `AppData` still has its word
            // log there, and losing it would mean paying to look every word
            // up again.
            paths::migrate_legacy_data(app.handle());

            let registry = MediaRegistry::new(app.handle().clone());
            app.manage(AppState {
                media: registry.clone(),
                jobs: Arc::new(Mutex::new(HashMap::new())),
            });

            // The player cannot be given a URL until the server has a port, so
            // this has to finish before the first `open_video`. It binds in
            // milliseconds; failing to bind is fatal because nothing would be
            // playable without it.
            tauri::async_runtime::block_on(registry.serve())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_video,
            commands::stream_url,
            commands::switch_audio_track,
            commands::get_analysis,
            commands::start_transcript,
            commands::start_breakdown,
            commands::cancel_analysis,
            commands::remove_analysis,
            commands::list_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::save_position,
            commands::get_settings,
            commands::save_settings,
            commands::set_api_key,
            commands::clear_cache,
            commands::list_words,
            commands::get_word,
            commands::list_kanji,
            commands::get_kanji,
            commands::list_word_sources,
            commands::clear_vocabulary,
            commands::preview_anki_export,
            commands::export_anki,
            commands::write_color_scheme,
            commands::read_color_scheme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

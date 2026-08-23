/**
 * The only module that talks to Rust.
 *
 * Everything above this file works with plain typed values and never imports
 * `@tauri-apps/api` directly, which keeps the invoke surface enumerable in one
 * place and mirrors `src-tauri/src/commands.rs` one-for-one.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";

import {
  AUTO_TRANSCRIPT,
  DEFAULT_ANKI_OPTIONS,
  DEFAULT_VOCAB_QUERY,
} from "@/lib/types";
import type {
  Analysis,
  AnkiExport,
  AnkiOptions,
  AnkiPreview,
  IpcError,
  KanjiDetail,
  KanjiStat,
  OpenedVideo,
  ProgressEvent,
  RecentEntry,
  Settings,
  SettingsView,
  TranscriptChoice,
  VocabEntry,
  VocabPage,
  VocabQuery,
  VocabSourceSummary,
} from "@/lib/types";

const PROGRESS_EVENT = "ringo://progress";

/** Container extensions offered in the file picker. */
const VIDEO_EXTENSIONS = [
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "webm",
  "wmv",
  "flv",
  "ts",
  "m2ts",
  "ogv",
  "mpg",
  "mpeg",
];

/**
 * An error that crossed the IPC boundary.
 *
 * Rust commands reject with `{ kind, message }`. `kind` is what UI code should
 * branch on — the messages are written for people and get reworded.
 */
export class RingoError extends Error {
  readonly kind: IpcError["kind"];

  constructor(kind: IpcError["kind"], message: string) {
    super(message);
    this.name = "RingoError";
    this.kind = kind;
  }

  /** True when the user cancelled, which callers usually swallow. */
  get isCancelled() {
    return this.kind === "cancelled";
  }
}

function toRingoError(cause: unknown): RingoError {
  if (
    cause &&
    typeof cause === "object" &&
    "kind" in cause &&
    "message" in cause
  ) {
    const { kind, message } = cause as IpcError;
    return new RingoError(kind, message);
  }
  // A panic or a serialization failure arrives as a bare string.
  return new RingoError(
    "other",
    typeof cause === "string" ? cause : "Something went wrong.",
  );
}

async function call<T>(command: string, args?: Record<string, unknown>) {
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    throw toRingoError(cause);
  }
}

/** Native file picker. Resolves to `null` when the user dismisses it. */
export async function pickVideoFile(): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Native folder picker, for choosing where the app writes its files.
 *
 * Resolves to `null` when the user dismisses it, which callers treat as
 * "leave the setting alone" rather than "clear it".
 */
export async function pickFolder(title?: string): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: true,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Native save dialog, for writing a file the user is meant to find again.
 *
 * Resolves to `null` when dismissed. Note that the dialog only *names* a
 * destination — nothing is written until the backend is asked to write it.
 */
export async function pickSaveFile(options: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  return await saveFileDialog(options);
}

export function openVideo(path: string) {
  return call<OpenedVideo>("open_video", { path });
}

/**
 * Switches the audio track. WebView2 exposes no `audioTracks` API on
 * `<video>`, so this is the only way to change dubs or commentary tracks —
 * the backend remuxes a stream containing just the chosen track and hands
 * back its URL, which the caller assigns to the element's `src`.
 */
export function switchAudioTrack(videoId: string, audioTrack: number | null) {
  return call<string>("switch_audio_track", { videoId, audioTrack });
}

/**
 * The exact-seek URL, once a background remux has produced one.
 *
 * Returns `null` while playback is still coming from the live stream, which is
 * what the player polls on to upgrade itself.
 */
export function exactStreamUrl(videoId: string) {
  return call<string | null>("stream_url", { videoId });
}

export function getAnalysis(videoId: string, choice: TranscriptChoice = AUTO_TRANSCRIPT) {
  return call<Analysis | null>("get_analysis", { videoId, choice });
}

/**
 * Builds the transcript and nothing else — no network, no cost.
 *
 * For a subtitle source this returns in about a second, which is why the UI
 * can call it the moment a track is picked. For `{ kind: "whisper" }` it runs
 * whisper.cpp over the audio and takes minutes, so subscribe with
 * {@link onProgress} first.
 */
export function startTranscript(
  videoId: string,
  choice: TranscriptChoice = AUTO_TRANSCRIPT,
  force = false,
) {
  return call<Analysis>("start_transcript", { videoId, choice, force });
}

/**
 * Runs the paid passes over an existing transcript: dictionary senses for
 * words not already cached, then the per-line translation and in-context
 * breakdown. Rejects when there is no transcript, no API key, or the
 * transcript is not Japanese.
 */
export function startBreakdown(
  videoId: string,
  choice: TranscriptChoice = AUTO_TRANSCRIPT,
) {
  return call<Analysis>("start_breakdown", { videoId, choice });
}

export function cancelAnalysis(videoId: string) {
  return call<void>("cancel_analysis", { videoId });
}

export function removeAnalysis(videoId: string, choice: TranscriptChoice = AUTO_TRANSCRIPT) {
  return call<void>("remove_analysis", { videoId, choice });
}

export function listRecent() {
  return call<RecentEntry[]>("list_recent");
}

export function removeRecent(videoId: string) {
  return call<void>("remove_recent", { videoId });
}

export function clearRecent() {
  return call<void>("clear_recent");
}

export function savePosition(videoId: string, position: number) {
  return call<void>("save_position", { videoId, position });
}

export function getSettings() {
  return call<SettingsView>("get_settings");
}

export function saveSettings(settings: Settings) {
  return call<SettingsView>("save_settings", { settings });
}

/** Stores the OpenAI key, or clears it with `null`. Returns whether one is set. */
export function setApiKey(key: string | null) {
  return call<boolean>("set_api_key", { key });
}

/** Empties the cache and returns the remaining size in bytes. */
export function clearCache() {
  return call<number>("clear_cache");
}

/**
 * One page of the vocabulary log — filtered, sorted, and counted by Rust,
 * which holds the whole log in memory and can answer this per keystroke.
 */
export function listWords(query: Partial<VocabQuery> = {}) {
  return call<VocabPage>("list_words", {
    query: { ...DEFAULT_VOCAB_QUERY, ...query },
  });
}

/**
 * Everything known about one word. `null` for a word never met, which is the
 * normal answer before a transcript has been through the breakdown.
 */
export function getWord(lemma: string) {
  return call<VocabEntry | null>("get_word", { lemma });
}

/** Kanji frequency across everything watched. `0` means no limit. */
export function listKanji(limit = 0) {
  return call<KanjiStat[]>("list_kanji", { limit });
}

/**
 * Everything the log knows about one kanji. `null` for a character never met,
 * which is every character until a transcript has been recorded.
 */
export function getKanji(character: string) {
  return call<KanjiDetail | null>("get_kanji", { character });
}

/** The series and videos words have been met in, for the filter menu. */
export function listWordSources() {
  return call<VocabSourceSummary[]>("list_word_sources");
}

/** Empties the vocabulary log — encounters *and* cached definitions. */
export function clearVocabulary() {
  return call<number>("clear_vocabulary");
}

/**
 * What the current Anki options would export, without writing anything.
 *
 * Cheap enough to call on every change in the export dialog: the log is
 * already in memory on the Rust side.
 */
export function previewAnkiExport(options: Partial<AnkiOptions> = {}) {
  return call<AnkiPreview>("preview_anki_export", {
    options: { ...DEFAULT_ANKI_OPTIONS, ...options },
  });
}

/** Writes the export to `path`, which comes from {@link pickSaveFile}. */
export function exportAnki(options: AnkiOptions, path: string) {
  return call<AnkiExport>("export_anki", { options, path });
}

/**
 * Native open dialog for a colour scheme. Resolves to `null` when dismissed.
 *
 * Separate from {@link pickVideoFile} only in its filter — the two file kinds
 * this app ever asks you to find are a video and a scheme.
 */
export async function pickSchemeFile(): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    title: "Open a colour scheme",
    filters: [{ name: "Colour scheme", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Writes a colour scheme to `path`, and resolves to the path written.
 *
 * The scheme's *format* belongs to `lib/color-scheme.ts`; Rust is involved
 * only because it is the side with a filesystem. See `commands.rs`.
 */
export function writeColorScheme(path: string, contents: string) {
  return call<string>("write_color_scheme", { path, contents });
}

/** Reads a scheme file back as text, for `lib/color-scheme.ts` to parse. */
export function readColorScheme(path: string) {
  return call<string>("read_color_scheme", { path });
}

/** Subscribes to pipeline progress. Resolves to an unsubscribe function. */
export function onProgress(
  handler: (event: ProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ProgressEvent>(PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}

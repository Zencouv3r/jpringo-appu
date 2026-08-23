/**
 * Mirror of the Rust types in `src-tauri/src/model.rs`.
 *
 * These are hand-maintained rather than generated, so the two files are meant
 * to be edited together. Every field here is `camelCase` because the Rust side
 * serializes with `#[serde(rename_all = "camelCase")]`.
 */

export type TranscriptSource =
  | "embeddedSubtitles"
  | "externalSubtitles"
  | "whisper";

export type PartOfSpeech =
  | "noun"
  | "verb"
  | "adjective"
  | "adverb"
  | "particle"
  | "auxiliaryVerb"
  | "conjunction"
  | "prefix"
  | "interjection"
  | "determiner"
  | "symbol"
  | "other";

export type JlptLevel = "N5" | "N4" | "N3" | "N2" | "N1" | "none";

/**
 * What a transcript's text actually is, judged from the text rather than from
 * the container's language tag. Only `japanese` can be broken down; everything
 * else is shown as plain text.
 */
export type Script =
  | "japanese"
  | "chinese"
  | "korean"
  | "latin"
  | "cyrillic"
  | "unknown";

/**
 * One word, as segmented by Lindera.
 *
 * `start`/`end` are character offsets into the parent segment's `text`, so
 * `[...text].slice(start, end)` reproduces `surface` exactly. Note the spread —
 * `text.slice()` indexes UTF-16 code units and would be wrong for characters
 * outside the BMP.
 */
export interface Token {
  surface: string;
  reading: string;
  base: string;
  pos: PartOfSpeech;
  start: number;
  end: number;
  clickable: boolean;
}

/**
 * A word or grammar item **as used in one line**.
 *
 * Everything here is context-dependent and regenerated on every breakdown:
 * `meaning` is the sense the word carries *here*. Its dictionary senses live
 * in {@link WordInfo}, which is cached across videos — that split is why a
 * second episode costs a fraction of the first.
 */
export interface Term {
  /** Dictionary form, matched against a token's `base`. */
  term: string;
  reading: string;
  /** What the word means in this line, not everything it can mean. */
  meaning: string;
  /** Conjugation or particle function here. Empty for a plain noun. */
  grammar: string;
  jlptLevel: JlptLevel;
  note: string;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  tokens: Token[];
  /** Empty until the breakdown pass has run. */
  translation: string;
  terms: Term[];
}

export interface Analysis {
  version: number;
  videoId: string;
  source: TranscriptSource;
  /** The track's language tag when it had one, else the detected script code. */
  language: string;
  /** Detected from the text. Only `japanese` supports the breakdown. */
  script: Script;
  segments: Segment[];
  /** False when the transcript exists but has no translations yet. */
  analyzed: boolean;
  whisperModel: string;
  llmModel: string;
  createdAt: number;
}

/** An audio track the player can switch to. `index` is the absolute ffprobe stream index. */
export interface AudioTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels: number | null;
  default: boolean;
}

/** A subtitle track that could serve as the transcript source. */
export interface SubtitleTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  /** Usually signs/songs rather than full dialogue. */
  forced: boolean;
  /** False for bitmap subtitles (PGS/VobSub), which this app can't read. */
  textual: boolean;
}

export type Playback = "direct" | "remux";

export interface VideoInfo {
  id: string;
  path: string;
  name: string;
  duration: number;
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  externalSubtitles: string[];
  playback: Playback;
  hasAnalysis: boolean;
}

export interface OpenedVideo extends VideoInfo {
  streamUrl: string;
  /** Resume point from the previous session, in seconds. */
  position: number;
  /** True while playing from the live remux, where seeking restarts the stream. */
  seekIsApproximate: boolean;
  /** Absolute stream index of the audio track currently playing, or `null` for the default. */
  audioTrack: number | null;
}

/**
 * Which source a transcript should be built from — mirrors Rust's
 * `TranscriptChoice`. `{ kind: "auto" }` picks the best Japanese subtitle track
 * by content; `{ kind: "whisper" }` is the only choice that transcribes audio,
 * and it only ever runs when asked for.
 */
export type TranscriptChoice =
  | { kind: "auto" }
  | { kind: "embedded"; value: number }
  | { kind: "external"; value: string }
  | { kind: "whisper" };

export const AUTO_TRANSCRIPT: TranscriptChoice = { kind: "auto" };

/** Stable key for a `TranscriptChoice`, for use as a React key or map key. */
export function transcriptChoiceKey(choice: TranscriptChoice): string {
  switch (choice.kind) {
    case "auto":
    case "whisper":
      return choice.kind;
    case "embedded":
      return `embedded:${choice.value}`;
    case "external":
      return `external:${choice.value}`;
  }
}

export interface RecentEntry {
  id: string;
  path: string;
  name: string;
  duration: number;
  openedAt: number;
  position: number;
  hasAnalysis: boolean;
  /** False when the file has been moved or deleted since it was opened. */
  exists: boolean;
}

/**
 * How much the model is allowed to think before answering.
 *
 * Reasoning tokens dominate both cost and latency for this task, and it's
 * extraction against a fixed schema rather than problem solving — `minimal`
 * is the default. Empty omits the parameter, which non-GPT-5 models require.
 */
export type ReasoningEffort = "" | "minimal" | "low" | "medium" | "high";

export interface Settings {
  modelPath: string | null;
  openaiModel: string;
  reasoningEffort: ReasoningEffort;
  whisperThreads: number;
  useGpu: boolean;
  preferExistingSubtitles: boolean;
  batchSize: number;
  concurrency: number;
  prepareRemux: boolean;
  language: string;
  /**
   * Where the app writes the cache, the vocabulary log, and the recents list.
   * `null` means the default — a `ringo-data` folder beside the executable.
   */
  dataDir: string | null;
}

export interface SettingsView extends Settings {
  hasApiKey: boolean;
  resolvedModelPath: string | null;
  modelAvailable: boolean;
  gpuAvailable: boolean;
  cacheBytes: number;
  /** Distinct words in the vocabulary log. */
  vocabularyWords: number;
  /** The data folder actually in use, after fallbacks. */
  resolvedDataDir: string | null;
  /** Where the default would put it — shown as the field's placeholder. */
  defaultDataDir: string | null;
  /** False when the chosen folder could not be written to and was skipped. */
  dataDirAvailable: boolean;
}


// ---------------------------------------------------------------------------
// The vocabulary log
// ---------------------------------------------------------------------------

/**
 * The context-free half of a word: what a dictionary would tell you.
 *
 * Generated once per word and reused for every video it ever appears in
 * again, which is what makes a gloss for *every* word affordable.
 */
export interface WordInfo {
  /** Dictionary form. The store's key. */
  lemma: string;
  reading: string;
  /** One to three English glosses, most common first. */
  senses: string[];
  partOfSpeech: string;
  jlptLevel: JlptLevel;
  /** Register or usage note that holds regardless of context. */
  note: string;
}

/** One video a word was met in, and how often it occurred there. */
export interface WordSource {
  videoId: string;
  title: string;
  /** Series guessed from the filename, so episodes group together. */
  series: string;
  count: number;
  lastSeen: number;
}

/** A line the word actually appeared in. */
export interface WordExample {
  videoId: string;
  title: string;
  start: number;
  text: string;
  /** The surface form as inflected in this line. */
  surface: string;
  translation: string;
  /** What the word meant here, when the breakdown explained it. */
  meaning: string;
  grammar: string;
}

/** Everything the app knows about one word. `WordInfo` is flattened into it. */
export interface VocabEntry extends WordInfo {
  /** Total encounters across every video. */
  count: number;
  sources: WordSource[];
  examples: WordExample[];
  firstSeen: number;
  lastSeen: number;
}

export interface KanjiStat {
  character: string;
  /** Occurrences, counted through the words that contain it. */
  count: number;
  wordCount: number;
  /** The most frequent words using it. */
  words: string[];
  lastSeen: number;
}

/**
 * One reading of a kanji, as evidenced by the words it was met in.
 *
 * Never looked up: a reading is here only because some word in the log spells
 * it out — 食べる saying that 食 is read た. Compounds contribute nothing,
 * since which of 日 and 本 owns which mora of にほん is exactly the guess the
 * furigana alignment refuses to make.
 */
export interface KanjiReading {
  /** In hiragana, as the words themselves are read. */
  reading: string;
  /** Encounters read this way, summed over the words evidencing it. */
  count: number;
  /** Those words, most frequent first. */
  words: string[];
}

/** One word in the log that uses a kanji. */
export interface KanjiWord {
  lemma: string;
  reading: string;
  count: number;
  jlptLevel: JlptLevel;
  /** Empty until the dictionary pass has defined the word. */
  senses: string[];
  /** What this word reads the character as. Empty when unattributable. */
  kanjiReading: string;
}

/** Everything the log knows about one kanji, for the panel beside the grid. */
export interface KanjiDetail {
  character: string;
  count: number;
  /** Distinct words containing it. `words` may be a shorter, capped view. */
  wordCount: number;
  lastSeen: number;
  readings: KanjiReading[];
  /**
   * Senses of the character *as a word in its own right*, when the log has met
   * it alone. Empty for a character only ever seen inside compounds, which is
   * the honest answer: nothing here defines characters.
   */
  senses: string[];
  note: string;
  reading: string;
  jlptLevel: JlptLevel;
  words: KanjiWord[];
}

export type VocabSort = "frequency" | "recent" | "jlpt" | "alphabetical";

export interface VocabQuery {
  /** Matches the word, its reading, or any of its senses. */
  search: string;
  series: string | null;
  videoId: string | null;
  jlpt: JlptLevel | null;
  minCount: number;
  sort: VocabSort;
  offset: number;
  /** Zero means the backend's default page size. */
  limit: number;
}

/**
 * Rows per page of the dictionary screen.
 *
 * Named here rather than left as the `limit: 0` that means "whatever Rust's
 * default is". The screen pages by adding and subtracting this number, and it
 * cannot do that against a page size it has never been told: the last page is
 * short, so stepping back by the number of rows *returned* lands between
 * pages. Matches `DEFAULT_LIMIT` in `vocab.rs`, which is what a zero would
 * have resolved to anyway.
 */
export const VOCAB_PAGE_SIZE = 100;

export const DEFAULT_VOCAB_QUERY: VocabQuery = {
  search: "",
  series: null,
  videoId: null,
  jlpt: null,
  minCount: 0,
  sort: "frequency",
  offset: 0,
  limit: VOCAB_PAGE_SIZE,
};

export interface VocabPage {
  entries: VocabEntry[];
  /** Matches before paging. */
  total: number;
  totalWords: number;
  totalEncounters: number;
  /** Words still waiting on a dictionary lookup. */
  undefined: number;
}

export interface VocabVideoSummary {
  videoId: string;
  title: string;
  wordCount: number;
  lastSeen: number;
}

export interface VocabSourceSummary {
  series: string;
  videos: VocabVideoSummary[];
  wordCount: number;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Anki export
// ---------------------------------------------------------------------------

/**
 * The buckets a word can be exported by, mirroring `anki::WordCategory`.
 *
 * Coarser than {@link PartOfSpeech}: this answers "which of these do I want on
 * flashcards?" rather than describing grammar.
 */
export type WordCategory =
  | "noun"
  | "verb"
  | "adjective"
  | "adverb"
  | "particle"
  | "other";

/** Display order and labels for the category checkboxes. */
export const WORD_CATEGORIES: { value: WordCategory; label: string }[] = [
  { value: "noun", label: "Nouns" },
  { value: "verb", label: "Verbs" },
  { value: "adjective", label: "Adjectives" },
  { value: "adverb", label: "Adverbs" },
  { value: "particle", label: "Particles" },
  { value: "other", label: "Everything else" },
];

export interface AnkiOptions {
  /** Empty exports nothing — see the note in `anki.rs`. */
  categories: WordCategory[];
  /** Keep only the N most frequent matches. Zero means no ceiling. */
  limit: number;
  /** Skip words met fewer than this many times. */
  minCount: number;
  /** Restrict to one series. `null` is everything watched. */
  series: string | null;
  /** Skip words the dictionary pass has not defined yet. */
  requireMeaning: boolean;
  /** Reading as furigana notation rather than plain kana. */
  furigana: boolean;
  /** Append a tags column for Anki to file the notes under. */
  includeTags: boolean;
}

export const DEFAULT_ANKI_OPTIONS: AnkiOptions = {
  categories: ["noun", "verb", "adjective", "adverb"],
  limit: 100,
  minCount: 1,
  series: null,
  requireMeaning: true,
  furigana: true,
  includeTags: true,
};

/** One row of the export. */
export interface AnkiCard {
  word: string;
  reading: string;
  meaning: string;
  example: string;
  exampleTranslation: string;
  tags: string[];
}

export interface CategoryCount {
  category: WordCategory;
  words: number;
}

/** What the current options would write, computed without writing it. */
export interface AnkiPreview {
  /** Rows that would be written, after the limit. */
  cards: number;
  /** Rows that matched before the limit, for "100 of 812". */
  matched: number;
  withExample: number;
  /** Words excluded only because they have not been looked up yet. */
  withoutMeaning: number;
  /** Per-bucket totals under the current scope, whatever is selected. */
  counts: CategoryCount[];
  sample: AnkiCard[];
}

export interface AnkiExport {
  path: string;
  cards: number;
  withExample: number;
}

/** Pipeline progress, mirroring `pipeline::Stage`. */
export type ProgressStage =
  | { stage: "readingSubtitles"; track: number | null }
  | { stage: "subtitleRejected"; track: string; reason: string }
  | { stage: "extractingAudio" }
  | { stage: "transcribing"; percent: number }
  | { stage: "tokenizing" }
  | { stage: "lookingUpWords"; done: number; total: number }
  | { stage: "analyzing"; done: number; total: number }
  | { stage: "done" }
  | { stage: "failed"; message: string }
  | { stage: "cancelled" };

export type ProgressEvent = ProgressStage & { videoId: string };

/** Serialized `AppError`. `kind` is stable; `message` is for humans. */
export interface IpcError {
  kind:
    | "notFound"
    | "invalidInput"
    | "busy"
    | "missingModel"
    | "missingSidecar"
    | "sidecar"
    | "openai"
    | "cancelled"
    | "io"
    | "other";
  message: string;
}

//! Types shared with the frontend.
//!
//! Everything here is `camelCase` on the wire so the TypeScript mirror in
//! `src/lib/types.ts` reads naturally. The OpenAI request/response shapes are
//! deliberately *not* in this module — they live in [`crate::analyze::openai`]
//! and are translated at the boundary, so a change to the provider's schema
//! can't silently reshape what the UI consumes.

use serde::{Deserialize, Serialize};

use crate::language::Script;

/// Schema version for cached analyses. Bump whenever a field's *meaning*
/// changes; [`crate::cache`] discards anything older so stale files are
/// regenerated rather than deserialized into something subtly wrong.
///
/// v2 split the breakdown in two: `Term` describes a word **in its line**
/// (contextual meaning plus grammar), while the context-free senses moved to
/// the [`crate::vocab`] store so they are paid for once and reused forever.
pub const ANALYSIS_VERSION: u32 = 2;

/// Where a transcript came from. Surfaced in the UI because an embedded
/// subtitle track is authoritative while whisper output is a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptSource {
    /// A Japanese subtitle stream muxed into the video file.
    EmbeddedSubtitles,
    /// A sibling `.srt`/`.ass`/`.vtt` file next to the video.
    ExternalSubtitles,
    /// Generated locally by whisper.cpp.
    Whisper,
}

/// One morphological unit, produced by Lindera.
///
/// `start`/`end` are **character** offsets into the parent segment's `text`,
/// not bytes — the frontend slices with them directly, and byte offsets would
/// be wrong for every kanji.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub surface: String,
    /// Hiragana reading. Empty when the dictionary has no entry (e.g. digits,
    /// latin text, or an unknown proper noun).
    pub reading: String,
    /// Dictionary/base form — 食べた becomes 食べる. Equal to `surface` when
    /// the token is not inflected.
    pub base: String,
    /// Coarse part of speech, already mapped out of IPADIC's Japanese labels.
    pub pos: PartOfSpeech,
    pub start: usize,
    pub end: usize,
    /// False for punctuation and symbols, which render as plain text rather
    /// than clickable spans.
    pub clickable: bool,
}

/// IPADIC's top-level 品詞 categories, collapsed to the set worth treating
/// differently in the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PartOfSpeech {
    Noun,
    Verb,
    Adjective,
    Adverb,
    Particle,
    AuxiliaryVerb,
    Conjunction,
    Prefix,
    Interjection,
    Determiner,
    Symbol,
    Other,
}

impl PartOfSpeech {
    /// Maps IPADIC's Japanese POS label to our enum.
    pub fn from_ipadic(label: &str) -> Self {
        match label {
            "名詞" => Self::Noun,
            "動詞" => Self::Verb,
            "形容詞" => Self::Adjective,
            "副詞" => Self::Adverb,
            "助詞" => Self::Particle,
            "助動詞" => Self::AuxiliaryVerb,
            "接続詞" => Self::Conjunction,
            "接頭詞" => Self::Prefix,
            "感動詞" => Self::Interjection,
            "連体詞" => Self::Determiner,
            "記号" => Self::Symbol,
            _ => Self::Other,
        }
    }

    /// Symbols carry no meaning to explain, so they are not clickable.
    pub fn is_clickable(self) -> bool {
        !matches!(self, Self::Symbol)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum JlptLevel {
    N5,
    N4,
    N3,
    N2,
    N1,
    /// Not on any JLPT list — proper nouns, slang, and anything the model
    /// couldn't place. Also the default, so a missing field never invents a
    /// level the word was never given.
    #[default]
    #[serde(rename = "none")]
    None,
}

/// A word or grammar item **as used in one particular line**.
///
/// Everything here is context-dependent and therefore regenerated every time
/// the breakdown runs: `meaning` is the sense the word carries *here*, not its
/// dictionary entry. The context-free half — the two or three glosses a
/// dictionary would list — lives in [`WordInfo`] and is cached across videos,
/// which is the whole reason the two are separate types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    /// Dictionary form, so it can be matched against a token's `base` and
    /// looked up in the vocabulary store.
    pub term: String,
    pub reading: String,
    /// What this word means *in this line*, picked from among its senses.
    pub meaning: String,
    /// How the grammar of this term works here — conjugation, the particle's
    /// job, the pattern it belongs to. Empty for plain vocabulary.
    #[serde(default)]
    pub grammar: String,
    pub jlpt_level: JlptLevel,
    /// Slang, idiom, or cultural note. Empty when nothing non-obvious applies.
    pub note: String,
}

/// A transcript line, optionally enriched with translation and term notes.
///
/// `start`/`end` are seconds. They come from whisper or the subtitle track and
/// are never round-tripped through the LLM — see [`crate::analyze::openai`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub tokens: Vec<Token>,
    /// Empty until the breakdown pass has run for this segment.
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub terms: Vec<Term>,
}

/// Which source the transcript should be built from.
///
/// Cached separately per choice, so switching between an embedded track and a
/// whisper run — or between two subtitle tracks — never discards work that was
/// already paid for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TranscriptChoice {
    /// Let the pipeline pick: best Japanese subtitle track, else whisper.
    #[default]
    Auto,
    /// A specific embedded subtitle stream, by absolute index.
    Embedded(u32),
    /// A specific sibling subtitle file, by path.
    External(String),
    /// Force local transcription even if subtitles exist.
    Whisper,
}

impl TranscriptChoice {
    /// Filename suffix that keeps each choice's analysis in its own cache slot.
    pub fn cache_suffix(&self) -> String {
        match self {
            Self::Auto => String::new(),
            Self::Embedded(index) => format!("-s{index}"),
            Self::Whisper => "-w".to_string(),
            // Paths can be long and contain characters a filename cannot, so
            // the path is hashed rather than embedded.
            Self::External(path) => {
                format!("-x{}", &blake3::hash(path.as_bytes()).to_hex()[..8])
            }
        }
    }
}

/// The full, cacheable result for one video file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub version: u32,
    /// Content hash of the source video — the cache key. Survives renames and
    /// moves, which a path-based key would not.
    pub video_id: String,
    pub source: TranscriptSource,
    /// Best guess at the transcript's language: the subtitle track's tag when
    /// the container carried one, otherwise the detected script's code.
    pub language: String,
    /// What the transcript's text actually *is*, judged from the text rather
    /// than from a tag. Only [`Script::Japanese`] can be broken down; every
    /// other script is displayed as plain text and nothing more.
    #[serde(default = "unknown_script")]
    pub script: Script,
    pub segments: Vec<Segment>,
    /// False when transcription succeeded but the LLM breakdown did not run
    /// (no API key, cancelled, or failed). The transcript is still usable.
    pub analyzed: bool,
    pub whisper_model: String,
    pub llm_model: String,
    /// Unix seconds.
    pub created_at: u64,
}

fn unknown_script() -> Script {
    Script::Unknown
}

impl Analysis {
    /// Whether the breakdown pass can run on this transcript.
    ///
    /// The tokenizer, the JLPT levels, and the whole prompt assume Japanese.
    /// Handing a Chinese or English track to any of them produces confident
    /// nonsense, so a non-Japanese transcript is display-only.
    pub fn is_explainable(&self) -> bool {
        self.script == Script::Japanese
    }
}

/// The context-free half of a word: what a dictionary would tell you.
///
/// Generated once per lemma and then reused for every video that word ever
/// appears in — see [`crate::vocab`]. Nothing here depends on a sentence, which
/// is precisely what makes it cacheable.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordInfo {
    /// Dictionary form. The store's key.
    pub lemma: String,
    pub reading: String,
    /// One to three English glosses, most common first.
    #[serde(default)]
    pub senses: Vec<String>,
    #[serde(default)]
    pub part_of_speech: String,
    #[serde(default)]
    pub jlpt_level: JlptLevel,
    /// Register or usage note that holds regardless of context — "casual",
    /// "mostly written", "usually kana". Empty when nothing applies.
    #[serde(default)]
    pub note: String,
}

impl WordInfo {
    /// True once the senses have been filled in by the dictionary pass. An
    /// entry that only carries encounter counts is not worth caching against.
    pub fn is_defined(&self) -> bool {
        !self.senses.is_empty()
    }
}

/// One video a word was met in, with how often it occurred there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordSource {
    pub video_id: String,
    /// The file's name at the time it was watched.
    pub title: String,
    /// Series title guessed from the filename, so episodes group together.
    #[serde(default)]
    pub series: String,
    pub count: u32,
    /// Unix seconds.
    pub last_seen: u64,
}

/// A line the word actually appeared in, kept so the dictionary can show real
/// usage rather than invented examples.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExample {
    pub video_id: String,
    pub title: String,
    /// Seconds into the video, so a future "jump to this line" has what it needs.
    pub start: f64,
    pub text: String,
    /// The surface form as inflected in this line.
    pub surface: String,
    #[serde(default)]
    pub translation: String,
    /// What the word meant here, when the breakdown explained it.
    #[serde(default)]
    pub meaning: String,
    #[serde(default)]
    pub grammar: String,
}

/// Everything the app knows about one word: its dictionary entry, how often it
/// has been met, where, and in what sentences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntry {
    #[serde(flatten)]
    pub info: WordInfo,
    /// Total encounters across every video, i.e. the sum of `sources`.
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub sources: Vec<WordSource>,
    #[serde(default)]
    pub examples: Vec<WordExample>,
    #[serde(default)]
    pub first_seen: u64,
    #[serde(default)]
    pub last_seen: u64,
}

/// How a word's frequency looks against one kanji.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiStat {
    pub character: String,
    /// Total occurrences, counted through the words that contain it.
    pub count: u32,
    /// How many distinct words in the log use this kanji.
    pub word_count: u32,
    /// The most frequent words containing it, for the detail view.
    pub words: Vec<String>,
    pub last_seen: u64,
}

/// One reading of a kanji, as evidenced by the words it was met in.
///
/// Never looked up: a reading is here only because some word in the log spells
/// it out — 食べる saying that 食 is read た. Compounds contribute nothing,
/// since which of 日 and 本 owns which mora of にほん is exactly the guess
/// [`crate::furigana`] refuses to make.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiReading {
    /// In hiragana, as the words themselves are read.
    pub reading: String,
    /// Encounters read this way, summed over the words evidencing it.
    pub count: u32,
    /// Those words, most frequent first.
    pub words: Vec<String>,
}

/// One word in the log that uses a kanji.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiWord {
    pub lemma: String,
    pub reading: String,
    pub count: u32,
    pub jlpt_level: JlptLevel,
    /// Empty until the dictionary pass has defined the word.
    pub senses: Vec<String>,
    /// What this word reads the character as. Empty when it cannot be
    /// attributed — a compound, or a reading that would not align.
    pub kanji_reading: String,
}

/// Everything the log knows about one kanji, for the dictionary's kanji panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanjiDetail {
    pub character: String,
    /// Occurrences, counted through the words that contain it.
    pub count: u32,
    /// Distinct words containing it. `words` may be a shorter, capped view.
    pub word_count: u32,
    pub last_seen: u64,
    pub readings: Vec<KanjiReading>,
    /// Senses of the character *as a word in its own right*, when the log has
    /// met it alone. Empty for a character only ever seen inside compounds,
    /// which is the honest answer: nothing here defines characters.
    pub senses: Vec<String>,
    pub note: String,
    pub reading: String,
    pub jlpt_level: JlptLevel,
    pub words: Vec<KanjiWord>,
}

/// Sort order for the vocabulary list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VocabSort {
    /// Most frequently met first — the default, and the useful one for study.
    #[default]
    Frequency,
    /// Most recently met first.
    Recent,
    /// Easiest (N5) first, undated levels last.
    Jlpt,
    /// Dictionary order by reading.
    Alphabetical,
}

/// What the dictionary screen is asking for.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabQuery {
    /// Matches the lemma, its reading, or any of its senses.
    pub search: String,
    /// Restrict to words met in this series (as guessed from filenames).
    pub series: Option<String>,
    /// Restrict to words met in this specific video.
    pub video_id: Option<String>,
    pub jlpt: Option<JlptLevel>,
    /// Only words seen at least this many times.
    pub min_count: u32,
    pub sort: VocabSort,
    pub offset: usize,
    /// Zero means "the default page size" — the frontend never has to know it.
    pub limit: usize,
}

/// One page of dictionary results plus the totals the UI shows around it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabPage {
    pub entries: Vec<VocabEntry>,
    /// Matches before paging, so the list can say "1-50 of 812".
    pub total: usize,
    /// Distinct words in the whole log, whatever the filter.
    pub total_words: usize,
    /// Sum of every encounter in the whole log.
    pub total_encounters: u32,
    /// Words still waiting on a dictionary lookup.
    pub undefined: usize,
}

/// A series or video the log has words from, for the filter menu.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabSourceSummary {
    pub series: String,
    pub videos: Vec<VocabVideoSummary>,
    pub word_count: usize,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabVideoSummary {
    pub video_id: String,
    pub title: String,
    pub word_count: usize,
    pub last_seen: u64,
}

/// An audio track the player can switch to.
///
/// `index` is the *absolute* ffprobe stream index, not the nth audio stream —
/// the two differ on every file whose video stream comes first, which is all of
/// them, and mixing them up silently selects the wrong track.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub index: u32,
    pub codec: String,
    /// Language tag from the container, lowercased. Often absent.
    pub language: Option<String>,
    pub title: Option<String>,
    pub channels: Option<u32>,
    /// Marked default by the container.
    pub default: bool,
}

/// A subtitle track that could serve as the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub index: u32,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    /// Marked forced — usually signs and songs rather than full dialogue.
    pub forced: bool,
    /// False for bitmap subtitles (PGS/VobSub), which carry pixels rather than
    /// text and would need OCR.
    pub textual: bool,
}

/// What we learned about a video file before doing any work on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub container: String,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size_bytes: u64,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitle_tracks: Vec<SubtitleTrack>,
    /// Sibling `.srt`/`.ass`/`.vtt` files discovered next to the video.
    pub external_subtitles: Vec<String>,
    /// How the player should fetch this file — see [`crate::media::server`].
    pub playback: Playback,
    /// True when a cached analysis already exists for this `id`.
    pub has_analysis: bool,
}

impl VideoInfo {
    /// Codec of the audio stream that will actually be muxed for `audio_track`.
    ///
    /// [`Self::audio_codec`] describes the container's *first* audio stream,
    /// which stops being the right answer the moment the user picks a different
    /// one. Getting this wrong is not cosmetic: it decides copy-versus-
    /// transcode, and copying a FLAC or DTS track into an MP4 fails outright
    /// while copying AC-3 produces a file WebView2 plays back silently.
    pub fn audio_codec_for(&self, audio_track: Option<u32>) -> Option<&str> {
        audio_codec_of(&self.audio_tracks, audio_track, self.audio_codec.as_deref())
    }
}

/// Shared by [`VideoInfo`] and the media registry, which each hold their own
/// copy of the track list but have to answer this question identically.
pub fn audio_codec_of<'a>(
    tracks: &'a [AudioTrack],
    audio_track: Option<u32>,
    fallback: Option<&'a str>,
) -> Option<&'a str> {
    match audio_track {
        Some(index) => tracks
            .iter()
            .find(|t| t.index == index)
            .map(|t| t.codec.as_str()),
        None => fallback,
    }
}

/// How the embedded `<video>` element should source this file.
///
/// WebView2 plays MP4 and WebM natively but has no MKV demuxer, which is the
/// common case for anime releases — hence the remux path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Playback {
    /// Container and codecs are web-native: serve the file bytes as-is with
    /// range support, so seeking is exact and free.
    Direct,
    /// Needs ffmpeg in the middle. Playback starts immediately from a live
    /// fragmented-MP4 stream; seeking restarts that stream at an offset until
    /// a cached remux finishes, after which it upgrades to `Direct`.
    Remux,
}

/// An entry in the "recently opened" list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: String,
    pub path: String,
    pub name: String,
    pub duration: f64,
    /// Unix seconds.
    pub opened_at: u64,
    /// Playback position in seconds, so reopening resumes where you left off.
    #[serde(default)]
    pub position: f64,
    pub has_analysis: bool,
    /// False when the file has since been moved or deleted. Kept in the list
    /// (greyed out) rather than silently dropped.
    #[serde(default = "default_true")]
    pub exists: bool,
}

fn default_true() -> bool {
    true
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(index: u32, codec: &str) -> AudioTrack {
        AudioTrack {
            index,
            codec: codec.into(),
            language: None,
            title: None,
            channels: Some(2),
            default: index == 1,
        }
    }

    /// The bug this exists to prevent: an MKV whose first audio track is AAC
    /// and whose second is FLAC. Answering with the file-level `audio_codec`
    /// for the second track tells the remux to `-c:a copy` a FLAC stream into
    /// an MP4, which ffmpeg refuses outright — the switch fails instead of
    /// transcoding.
    #[test]
    fn a_switched_to_track_reports_its_own_codec() {
        let tracks = [track(1, "aac"), track(2, "flac")];
        assert_eq!(audio_codec_of(&tracks, Some(2), Some("aac")), Some("flac"));
    }

    #[test]
    fn no_selection_falls_back_to_the_containers_first_track() {
        let tracks = [track(1, "aac"), track(2, "flac")];
        assert_eq!(audio_codec_of(&tracks, None, Some("aac")), Some("aac"));
    }

    #[test]
    fn an_unknown_index_reports_nothing_rather_than_the_wrong_codec() {
        // Nothing is safer than a wrong answer here: an unknown codec makes
        // the remux transcode, which always works.
        let tracks = [track(1, "aac")];
        assert_eq!(audio_codec_of(&tracks, Some(9), Some("aac")), None);
    }
}

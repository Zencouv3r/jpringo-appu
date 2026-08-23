//! The vocabulary log: every word the user has met, and what it means.
//!
//! Two jobs live here, and they share a file because they are the same data
//! seen from two sides:
//!
//! * **A dictionary cache.** A word's senses do not depend on the sentence it
//!   was found in, so they are asked for once and then reused for every video
//!   that word ever appears in again. The second episode of a series is
//!   overwhelmingly the same vocabulary as the first; paying for it twice is
//!   paying for nothing.
//! * **An encounter log.** How often a word has come up, in which videos, and
//!   in what sentences — which is what turns "I looked this up once" into a
//!   study list ordered by what the user actually keeps running into.
//!
//! Recording is **idempotent per video**: a video's contribution is stripped
//! before it is re-added, so regenerating a transcript corrects the counts
//! rather than doubling them. Entries are never deleted when their count drops
//! to zero, because the senses attached to them were paid for.
//!
//! Backed by one JSON file in the app's data folder, held in memory behind a
//! mutex. It is tens of thousands of small entries at the very most, read on
//! every dictionary keystroke and written once per analysis, which a file this
//! size handles comfortably and a database would only complicate.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::Result;
use crate::furigana::{self, Ruby};
use crate::language;
use crate::model::{
    now_secs, Analysis, JlptLevel, KanjiDetail, KanjiReading, KanjiStat, KanjiWord, PartOfSpeech,
    Segment, Term, VocabEntry, VocabPage, VocabQuery, VocabSort, VocabSourceSummary,
    VocabVideoSummary, WordExample, WordInfo, WordSource,
};
use crate::paths;

/// Public so [`crate::paths::migrate_legacy_data`] can name the file it moves
/// out of the old per-user config directory.
pub(crate) const VOCABULARY_FILE: &str = "vocabulary.json";

/// Bumped only for changes that make old entries *wrong*. Unlike the analysis
/// cache this is never discarded wholesale — it holds the only copy of work
/// that cost money — so a bump migrates rather than regenerates.
const VOCABULARY_VERSION: u32 = 1;

/// Example sentences kept per word. Enough to show a word used more than one
/// way, few enough that a 10,000-word log stays a few megabytes.
const MAX_EXAMPLES: usize = 6;

/// Of those, how many may come from a single video — otherwise one talkative
/// episode fills every slot and the word looks like it only appears there.
const MAX_EXAMPLES_PER_VIDEO: usize = 2;

/// The example length that reads best: long enough to show grammar, short
/// enough to scan. Candidates are ranked by distance from it.
const IDEAL_EXAMPLE_CHARS: usize = 24;

/// Default page size for the dictionary screen.
const DEFAULT_LIMIT: usize = 100;

/// Words named on a kanji card in the grid — a glance at what it turns up in.
const KANJI_PREVIEW_WORDS: usize = 12;

/// Words listed in the kanji panel. A common character appears in hundreds of
/// them; the frequent ones are the ones worth reading, and the panel says how
/// many it is not showing.
const KANJI_DETAIL_WORDS: usize = 60;

/// Words quoted as evidence for one reading of a kanji.
const KANJI_READING_WORDS: usize = 6;

#[derive(Debug, Serialize, Deserialize)]
struct Vocabulary {
    version: u32,
    /// Keyed by dictionary form. A `BTreeMap` so the file is diff-friendly and
    /// alphabetical iteration is free.
    #[serde(default)]
    words: BTreeMap<String, VocabEntry>,
}

impl Default for Vocabulary {
    fn default() -> Self {
        Self { version: VOCABULARY_VERSION, words: BTreeMap::new() }
    }
}

fn vocabulary_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(paths::data_dir(app)?.join(VOCABULARY_FILE))
}

fn load_from_disk(app: &AppHandle) -> Vocabulary {
    let Ok(path) = vocabulary_path(app) else {
        return Vocabulary::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
            // Losing the log is bad enough to say loudly, but not bad enough to
            // stop the app: it rebuilds itself as videos are watched.
            log::error!("vocabulary.json is unreadable ({err}); starting a fresh log");
            Vocabulary::default()
        }),
        Err(_) => Vocabulary::default(),
    }
}

fn flush(app: &AppHandle, vocabulary: &Vocabulary) -> Result<()> {
    let path = vocabulary_path(app)?;
    // Same temp-then-rename as the analysis cache: a crash while writing must
    // not leave a truncated file where the only copy of the senses used to be.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(vocabulary)?)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// The in-memory copy of the log. `None` until something asks for it, and put
/// back to `None` by [`forget_cached`] when the file it came from moves.
fn cache() -> &'static Mutex<Option<Vocabulary>> {
    static CACHE: OnceLock<Mutex<Option<Vocabulary>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Drops the in-memory log so the next read comes from disk.
///
/// Called when the data folder changes: the loaded log belongs to the file at
/// the *old* path, and writing it back would copy one user's history into a
/// location they had just pointed somewhere else on purpose.
pub fn forget_cached() {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
}

/// Runs `f` against the in-memory log, loading it on first use.
fn with_vocabulary<T>(app: &AppHandle, f: impl FnOnce(&mut Vocabulary) -> T) -> T {
    let cell = cache();
    // A poisoned lock means some other caller panicked mid-read; the data is
    // still structurally fine and dropping the whole log would be worse.
    let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let vocabulary = guard.get_or_insert_with(|| load_from_disk(app));
    f(vocabulary)
}

/// As above, but writes the result back to disk before returning.
fn mutate<T>(app: &AppHandle, f: impl FnOnce(&mut Vocabulary) -> T) -> Result<T> {
    with_vocabulary(app, |vocabulary| {
        let outcome = f(vocabulary);
        flush(app, vocabulary)?;
        Ok(outcome)
    })
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// One word's appearances inside a single video.
#[derive(Default)]
struct Occurrence {
    count: u32,
    reading: String,
    part_of_speech: String,
    examples: Vec<WordExample>,
}

/// Folds a transcript into the log.
///
/// Called after the transcript is written and again after the breakdown, so a
/// word met on a key-less machine is still logged — only its senses and its
/// contextual meanings wait for the paid pass. Returns how many distinct words
/// the video contributed.
pub fn record(app: &AppHandle, analysis: &Analysis, title: &str) -> Result<usize> {
    // Nothing in here is meaningful for a language the tokenizer does not
    // handle: a Chinese track has no `base` forms and no readings, and logging
    // its raw characters as "words met" would poison the study list.
    if !analysis.is_explainable() {
        return Ok(0);
    }

    let series = series_title(title);
    let seen = collect(analysis, title);
    let total = seen.len();
    let now = now_secs();

    mutate(app, |vocabulary| {
        // Strip this video's previous contribution first. Re-running an
        // analysis must correct the counts, never inflate them.
        forget_video(vocabulary, &analysis.video_id);

        for (lemma, occurrence) in seen {
            let entry = entry_for(vocabulary, &lemma, now);

            // Lindera's reading and part of speech fill in what the dictionary
            // pass has not covered yet, so a fresh log is still readable.
            if entry.info.reading.is_empty() {
                entry.info.reading = occurrence.reading;
            }
            if entry.info.part_of_speech.is_empty() {
                entry.info.part_of_speech = occurrence.part_of_speech;
            }

            entry.sources.push(WordSource {
                video_id: analysis.video_id.clone(),
                title: title.to_string(),
                series: series.clone(),
                count: occurrence.count,
                last_seen: now,
            });
            entry.count = entry.sources.iter().map(|s| s.count).sum();
            if entry.first_seen == 0 {
                entry.first_seen = now;
            }
            entry.last_seen = now;

            merge_examples(entry, occurrence.examples);
        }
    })?;

    Ok(total)
}

fn entry_for<'a>(vocabulary: &'a mut Vocabulary, lemma: &str, now: u64) -> &'a mut VocabEntry {
    vocabulary.words.entry(lemma.to_string()).or_insert_with(|| VocabEntry {
        info: WordInfo { lemma: lemma.to_string(), ..Default::default() },
        count: 0,
        sources: Vec::new(),
        examples: Vec::new(),
        first_seen: now,
        last_seen: now,
    })
}

/// Counts every clickable Japanese token in a transcript, keyed by lemma.
fn collect(analysis: &Analysis, title: &str) -> HashMap<String, Occurrence> {
    let mut seen: HashMap<String, Occurrence> = HashMap::new();

    for segment in &analysis.segments {
        for token in &segment.tokens {
            // Latin words and bare digits are clickable in the transcript (a
            // learner may still want the reading) but they are not Japanese
            // vocabulary and would swamp the frequency list.
            if !token.clickable || !token.surface.chars().any(language::is_japanese_char) {
                continue;
            }

            let lemma = if token.base.trim().is_empty() {
                token.surface.clone()
            } else {
                token.base.clone()
            };

            let occurrence = seen.entry(lemma.clone()).or_default();
            occurrence.count += 1;
            // Lindera reads the *surface*, so an inflected token's reading
            // belongs to 食べ, not to 食べる. Taking it anyway would file the
            // dictionary form under a truncated reading until the lookup pass
            // corrected it, so uninflected tokens are the only ones trusted.
            if occurrence.reading.is_empty() && token.surface == lemma {
                occurrence.reading = token.reading.clone();
            }
            if occurrence.part_of_speech.is_empty() {
                occurrence.part_of_speech = pos_label(token.pos).to_string();
            }

            // Every candidate line is collected and the best few are chosen in
            // `merge_examples`; capping here would keep whichever happened to
            // come first rather than whichever reads best.
            if occurrence.examples.len() < MAX_EXAMPLES * 4 {
                let term = match_term(&lemma, &token.surface, &segment.terms);
                occurrence.examples.push(example_from(
                    segment,
                    &analysis.video_id,
                    title,
                    &token.surface,
                    term,
                ));
            }
        }
    }

    seen
}

fn example_from(
    segment: &Segment,
    video_id: &str,
    title: &str,
    surface: &str,
    term: Option<&Term>,
) -> WordExample {
    WordExample {
        video_id: video_id.to_string(),
        title: title.to_string(),
        start: segment.start,
        text: segment.text.clone(),
        surface: surface.to_string(),
        translation: segment.translation.clone(),
        meaning: term.map(|t| t.meaning.clone()).unwrap_or_default(),
        grammar: term.map(|t| t.grammar.clone()).unwrap_or_default(),
    }
}

/// Matches a token to one of its line's explained terms.
///
/// Mirrors the frontend's lookup so a stored example carries the same
/// contextual note the word panel shows: exact dictionary form first, then the
/// inflected surface, then containment for multi-word patterns.
fn match_term<'a>(lemma: &str, surface: &str, terms: &'a [Term]) -> Option<&'a Term> {
    terms
        .iter()
        .find(|t| t.term == lemma)
        .or_else(|| terms.iter().find(|t| t.term == surface))
        .or_else(|| {
            terms.iter().find(|t| {
                t.term.chars().count() > 1 && (t.term.contains(lemma) || t.term.contains(surface))
            })
        })
}

/// Adds this video's best examples, keeping the per-video cap.
///
/// Ranked by how much they explain: a line with a contextual meaning beats one
/// with only a translation, which beats a bare line, and among equals the one
/// closest to [`IDEAL_EXAMPLE_CHARS`] wins.
fn merge_examples(entry: &mut VocabEntry, mut incoming: Vec<WordExample>) {
    incoming.sort_by_key(|example| {
        (
            example.meaning.is_empty(),
            example.translation.is_empty(),
            example.text.chars().count().abs_diff(IDEAL_EXAMPLE_CHARS),
        )
    });
    incoming.truncate(MAX_EXAMPLES_PER_VIDEO);

    for example in incoming {
        if entry.examples.len() < MAX_EXAMPLES {
            entry.examples.push(example);
            continue;
        }

        // Full. A newly explained example still displaces an unexplained one —
        // the breakdown pass runs after the transcript, and its examples are
        // strictly better than the ones recorded a minute earlier.
        if example.meaning.is_empty() {
            break;
        }
        let Some(index) = entry
            .examples
            .iter()
            .position(|existing| existing.meaning.is_empty())
        else {
            break;
        };
        entry.examples[index] = example;
    }
}

/// Removes everything one video contributed, leaving the cached senses alone.
fn forget_video(vocabulary: &mut Vocabulary, video_id: &str) {
    for entry in vocabulary.words.values_mut() {
        let before = entry.sources.len();
        entry.sources.retain(|source| source.video_id != video_id);
        if entry.sources.len() != before {
            entry.count = entry.sources.iter().map(|s| s.count).sum();
            entry.examples.retain(|example| example.video_id != video_id);
        }
    }
}

// ---------------------------------------------------------------------------
// The dictionary cache
// ---------------------------------------------------------------------------

/// Filters a lemma list down to the words that still need a definition.
///
/// This is the function that saves the money: on the second episode of a series
/// most lemmas are already here, and the lookup pass only pays for the rest.
pub fn undefined(app: &AppHandle, lemmas: &[String]) -> Vec<String> {
    with_vocabulary(app, |vocabulary| {
        let mut seen = HashSet::new();
        lemmas
            .iter()
            .filter(|lemma| seen.insert(lemma.as_str()))
            .filter(|lemma| !is_defined(vocabulary, lemma))
            .cloned()
            .collect()
    })
}

fn is_defined(vocabulary: &Vocabulary, lemma: &str) -> bool {
    vocabulary.words.get(lemma).is_some_and(|entry| entry.info.is_defined())
}

/// Stores dictionary entries returned by the lookup pass.
///
/// An entry with no senses is discarded rather than written: caching an empty
/// definition would mean never asking for that word again.
pub fn define(app: &AppHandle, infos: Vec<WordInfo>) -> Result<usize> {
    let now = now_secs();
    mutate(app, |vocabulary| {
        let mut stored = 0;
        for info in infos {
            if info.lemma.trim().is_empty() || !info.is_defined() {
                continue;
            }
            let entry = entry_for(vocabulary, &info.lemma, now);

            // Lindera's reading stands in until the model supplies one, and the
            // model's is the better of the two: it reads the word for the sense
            // it actually has, which a surface-form lookup cannot.
            let reading = if info.reading.trim().is_empty() {
                std::mem::take(&mut entry.info.reading)
            } else {
                info.reading
            };
            let part_of_speech = if info.part_of_speech.trim().is_empty() {
                std::mem::take(&mut entry.info.part_of_speech)
            } else {
                info.part_of_speech
            };

            entry.info = WordInfo {
                lemma: info.lemma,
                reading,
                senses: info.senses,
                part_of_speech,
                jlpt_level: info.jlpt_level,
                note: info.note,
            };
            stored += 1;
        }
        stored
    })
}

pub fn lookup(app: &AppHandle, lemma: &str) -> Option<VocabEntry> {
    with_vocabulary(app, |vocabulary| vocabulary.words.get(lemma).cloned())
}

/// Runs `f` over every entry in the log, borrowed rather than cloned.
///
/// For callers that need to sift the whole log rather than page through it —
/// the Anki export, in practice. Handing out a `Vec<VocabEntry>` instead would
/// copy several megabytes of senses and example sentences to answer a question
/// that only reads them.
pub fn with_words<T>(app: &AppHandle, f: impl FnOnce(&[&VocabEntry]) -> T) -> T {
    with_vocabulary(app, |vocabulary| {
        let all: Vec<&VocabEntry> = vocabulary.words.values().collect();
        f(&all)
    })
}

/// Every word a transcript contains, most frequent first.
///
/// The order matters: the lookup pass runs in batches and a run that is
/// cancelled or rate-limited halfway still covers the words the user will meet
/// most often.
pub fn lemmas_of(analysis: &Analysis) -> Vec<String> {
    let mut counted: Vec<(String, u32)> = collect(analysis, "")
        .into_iter()
        .map(|(lemma, occurrence)| (lemma, occurrence.count))
        .collect();
    counted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counted.into_iter().map(|(lemma, _)| lemma).collect()
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

pub fn query(app: &AppHandle, request: &VocabQuery) -> VocabPage {
    with_vocabulary(app, |vocabulary| page(vocabulary, request))
}

fn page(vocabulary: &Vocabulary, request: &VocabQuery) -> VocabPage {
    let search = request.search.trim().to_lowercase();
    let limit = if request.limit == 0 { DEFAULT_LIMIT } else { request.limit };

    let mut matches: Vec<&VocabEntry> = vocabulary
        .words
        .values()
        // A word with no encounters is a cached definition, not something the
        // user has met — it belongs to the dictionary cache, not the log.
        .filter(|entry| entry.count > 0 && entry.count >= request.min_count)
        .filter(|entry| matches_search(entry, &search))
        .filter(|entry| match &request.series {
            Some(series) => entry.sources.iter().any(|s| &s.series == series),
            None => true,
        })
        .filter(|entry| match &request.video_id {
            Some(video_id) => entry.sources.iter().any(|s| &s.video_id == video_id),
            None => true,
        })
        .filter(|entry| match request.jlpt {
            Some(level) => entry.info.jlpt_level == level,
            None => true,
        })
        .collect();

    sort_entries(&mut matches, request.sort);

    let total = matches.len();
    let entries = matches.into_iter().skip(request.offset).take(limit).cloned().collect();

    VocabPage {
        entries,
        total,
        total_words: vocabulary.words.values().filter(|e| e.count > 0).count(),
        total_encounters: vocabulary.words.values().map(|e| e.count).sum(),
        undefined: vocabulary
            .words
            .values()
            .filter(|e| e.count > 0 && !e.info.is_defined())
            .count(),
    }
}

fn matches_search(entry: &VocabEntry, search: &str) -> bool {
    if search.is_empty() {
        return true;
    }
    entry.info.lemma.to_lowercase().contains(search)
        || entry.info.reading.contains(search)
        || entry.info.senses.iter().any(|sense| sense.to_lowercase().contains(search))
}

fn sort_entries(entries: &mut [&VocabEntry], sort: VocabSort) {
    match sort {
        VocabSort::Frequency => entries
            .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.info.lemma.cmp(&b.info.lemma))),
        VocabSort::Recent => entries
            .sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then_with(|| b.count.cmp(&a.count))),
        VocabSort::Jlpt => entries.sort_by(|a, b| {
            jlpt_rank(a.info.jlpt_level)
                .cmp(&jlpt_rank(b.info.jlpt_level))
                .then_with(|| b.count.cmp(&a.count))
        }),
        VocabSort::Alphabetical => entries.sort_by(|a, b| reading_key(a).cmp(reading_key(b))),
    }
}

/// Kana order where a reading is known, and the word itself where it is not.
fn reading_key(entry: &VocabEntry) -> &str {
    if entry.info.reading.is_empty() {
        &entry.info.lemma
    } else {
        &entry.info.reading
    }
}

/// N5 first, unlevelled last — "no level" is usually a proper noun or slang,
/// which is the least useful thing to study first.
fn jlpt_rank(level: JlptLevel) -> u8 {
    match level {
        JlptLevel::N5 => 0,
        JlptLevel::N4 => 1,
        JlptLevel::N3 => 2,
        JlptLevel::N2 => 3,
        JlptLevel::N1 => 4,
        JlptLevel::None => 5,
    }
}

/// Kanji frequency, derived from the word log rather than stored separately.
///
/// A kanji's count is the sum of the counts of every word containing it, so 人
/// in both 人間 and 一人 counts twice over. That is the number a learner wants:
/// how often they have had to read this character.
pub fn kanji(app: &AppHandle, limit: usize) -> Vec<KanjiStat> {
    with_vocabulary(app, |vocabulary| {
        let mut stats: HashMap<char, KanjiStat> = HashMap::new();
        // Carried alongside rather than inside the stat, so the words can be
        // ranked before the counts they are ranked by go out of scope.
        let mut words: HashMap<char, Vec<(u32, String)>> = HashMap::new();

        for entry in vocabulary.words.values().filter(|e| e.count > 0) {
            // Each distinct character once per word: 人人 in one lemma is still
            // one word using that kanji.
            let mut seen = HashSet::new();
            for ch in entry.info.lemma.chars().filter(|c| language::is_han(*c)) {
                if !seen.insert(ch) {
                    continue;
                }
                let stat = stats.entry(ch).or_insert_with(|| KanjiStat {
                    character: ch.to_string(),
                    count: 0,
                    word_count: 0,
                    words: Vec::new(),
                    last_seen: 0,
                });
                stat.count += entry.count;
                stat.word_count += 1;
                stat.last_seen = stat.last_seen.max(entry.last_seen);
                words.entry(ch).or_default().push((entry.count, entry.info.lemma.clone()));
            }
        }

        let mut ranked: Vec<KanjiStat> = stats.into_values().collect();
        for stat in &mut ranked {
            let Some(mut using) = stat.character.chars().next().and_then(|ch| words.remove(&ch))
            else {
                continue;
            };
            // The card names only the first few, so which few they are
            // matters: the words the user keeps meeting, rather than whichever
            // the map happened to hand back first.
            using.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            stat.words =
                using.into_iter().map(|(_, lemma)| lemma).take(KANJI_PREVIEW_WORDS).collect();
        }
        ranked.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.character.cmp(&b.character)));
        if limit > 0 {
            ranked.truncate(limit);
        }
        ranked
    })
}

/// Everything the log knows about one kanji, for the panel beside the grid.
///
/// Assembled from the words rather than from a character dictionary, because
/// the log is all there is: the readings are the ones the user's own words
/// spell out, a meaning appears only if the character has been met as a word
/// by itself, and the examples are those words. `None` for a character never
/// met.
pub fn kanji_detail(app: &AppHandle, character: &str) -> Option<KanjiDetail> {
    let target = character.chars().next()?;

    with_vocabulary(app, |vocabulary| {
        let mut detail = KanjiDetail {
            character: target.to_string(),
            count: 0,
            word_count: 0,
            last_seen: 0,
            readings: Vec::new(),
            senses: Vec::new(),
            note: String::new(),
            reading: String::new(),
            jlpt_level: JlptLevel::None,
            words: Vec::new(),
        };
        // Keyed by reading, so 生 collects せい and い separately, each keeping
        // the words that put it there.
        let mut readings: HashMap<String, (u32, Vec<(u32, String)>)> = HashMap::new();

        for entry in vocabulary.words.values().filter(|e| e.count > 0) {
            if !entry.info.lemma.contains(target) {
                continue;
            }

            detail.count += entry.count;
            detail.word_count += 1;
            detail.last_seen = detail.last_seen.max(entry.last_seen);

            // The character as a word in its own right — 人, 本, 時 — is the
            // only place a meaning for it can honestly come from.
            if entry.info.lemma.chars().count() == 1 {
                detail.senses = entry.info.senses.clone();
                detail.note = entry.info.note.clone();
                detail.reading = entry.info.reading.clone();
                detail.jlpt_level = entry.info.jlpt_level;
            }

            let attributed = attributed_reading(&entry.info.lemma, &entry.info.reading, target);
            if let Some(reading) = &attributed {
                let slot = readings.entry(reading.clone()).or_insert((0, Vec::new()));
                slot.0 += entry.count;
                slot.1.push((entry.count, entry.info.lemma.clone()));
            }

            detail.words.push(KanjiWord {
                lemma: entry.info.lemma.clone(),
                reading: entry.info.reading.clone(),
                count: entry.count,
                jlpt_level: entry.info.jlpt_level,
                senses: entry.info.senses.clone(),
                kanji_reading: attributed.unwrap_or_default(),
            });
        }

        if detail.word_count == 0 {
            return None;
        }

        detail.words.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.lemma.cmp(&b.lemma)));
        detail.words.truncate(KANJI_DETAIL_WORDS);

        detail.readings = readings
            .into_iter()
            .map(|(reading, (count, mut words))| {
                words.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
                KanjiReading {
                    reading,
                    count,
                    words: words
                        .into_iter()
                        .map(|(_, lemma)| lemma)
                        .take(KANJI_READING_WORDS)
                        .collect(),
                }
            })
            .collect();
        detail
            .readings
            .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reading.cmp(&b.reading)));

        Some(detail)
    })
}

/// How `word` reads `target`, when the alignment can say.
///
/// Only a group of exactly one character answers: in 食べる the kana pin 食 to
/// た and to nothing else, while in 日本語 the four morae of にほんご belong to
/// three characters in some division this app has no way to know. A word that
/// uses the character twice and reads it two ways is left out as well — there
/// is nothing to say which occurrence is which.
fn attributed_reading(word: &str, reading: &str, target: char) -> Option<String> {
    let pieces = furigana::pieces(word, reading)?;
    let mut found: Option<String> = None;

    for piece in pieces {
        let Ruby::Base { text, reading } = piece else {
            continue;
        };
        let mut chars = text.chars();
        if chars.next() != Some(target) || chars.next().is_some() {
            continue;
        }
        match &found {
            Some(existing) if existing != &reading => return None,
            Some(_) => {}
            None => found = Some(reading),
        }
    }

    found
}

/// Series and videos the log has words from, newest first, for the filter menu.
pub fn sources(app: &AppHandle) -> Vec<VocabSourceSummary> {
    with_vocabulary(app, |vocabulary| {
        // "How many words" means *distinct* words, so this accumulates sets of
        // lemmas rather than tallies.
        let mut by_series: HashMap<String, HashMap<String, VideoTally>> = HashMap::new();
        let mut series_words: HashMap<String, HashSet<String>> = HashMap::new();

        for entry in vocabulary.words.values().filter(|e| e.count > 0) {
            for source in &entry.sources {
                let tally = by_series
                    .entry(source.series.clone())
                    .or_default()
                    .entry(source.video_id.clone())
                    .or_insert_with(|| VideoTally {
                        title: source.title.clone(),
                        words: HashSet::new(),
                        last_seen: 0,
                    });
                tally.words.insert(entry.info.lemma.clone());
                tally.last_seen = tally.last_seen.max(source.last_seen);

                series_words
                    .entry(source.series.clone())
                    .or_default()
                    .insert(entry.info.lemma.clone());
            }
        }

        let mut summaries: Vec<VocabSourceSummary> = by_series
            .into_iter()
            .map(|(series, videos)| {
                let mut videos: Vec<VocabVideoSummary> = videos
                    .into_iter()
                    .map(|(video_id, tally)| VocabVideoSummary {
                        video_id,
                        title: tally.title,
                        word_count: tally.words.len(),
                        last_seen: tally.last_seen,
                    })
                    .collect();
                videos.sort_by_key(|video| std::cmp::Reverse(video.last_seen));

                VocabSourceSummary {
                    last_seen: videos.iter().map(|v| v.last_seen).max().unwrap_or(0),
                    word_count: series_words.get(&series).map_or(0, HashSet::len),
                    series,
                    videos,
                }
            })
            .collect();

        summaries.sort_by_key(|summary| std::cmp::Reverse(summary.last_seen));
        summaries
    })
}

struct VideoTally {
    title: String,
    words: HashSet<String>,
    last_seen: u64,
}

/// Empties the log, cached senses included. Only ever called from Settings.
pub fn clear(app: &AppHandle) -> Result<()> {
    mutate(app, |vocabulary| {
        vocabulary.words.clear();
    })
}

/// Distinct words met, for the Settings summary.
pub fn word_count(app: &AppHandle) -> usize {
    with_vocabulary(app, |vocabulary| {
        vocabulary.words.values().filter(|e| e.count > 0).count()
    })
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/// Guesses a series title from a filename.
///
/// Release naming is not a format, but it is a *convention*, and the parts that
/// are not the title are far more recognisable than the title itself: bracketed
/// group tags, resolution markers, and an episode number after a dash. Cutting
/// at the first of those and tidying what is left groups a season's episodes
/// together, which is all this is for — a wrong guess costs a mislabelled
/// filter entry, not data.
pub fn series_title(name: &str) -> String {
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());

    // Dot-separated scene naming (`Show.Name.S01E02.1080p`) only reads as a
    // separator when there are no real spaces competing with it.
    let spaced =
        if stem.contains(' ') { stem.clone() } else { stem.replace(['.', '_'], " ") };

    // Bracketed tags carry the group, the CRC, and the source — never the title.
    let mut cleaned = String::with_capacity(spaced.len());
    let mut depth = 0usize;
    for ch in spaced.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => cleaned.push(ch),
            _ => {}
        }
    }

    let cut = episode_markers()
        .iter()
        .filter_map(|marker| marker.find(&cleaned).map(|m| m.start()))
        .min()
        .unwrap_or(cleaned.len());

    let title = cleaned[..cut]
        .trim()
        .trim_end_matches(['-', '–', '—', '~', ':', '_', '.', ' '])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if title.is_empty() {
        stem
    } else {
        title
    }
}

/// Patterns marking where the title stops and the release metadata starts.
fn episode_markers() -> &'static [regex::Regex] {
    static MARKERS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    MARKERS.get_or_init(|| {
        [
            // ` - 12`, ` – 12v2`: the most common anime convention.
            r"\s[-–—]\s*\d{1,4}(v\d)?(\s|$)",
            // `S01E02`, `1x02`.
            r"(?i)\bs\d{1,2}\s?e\d{1,3}\b",
            r"(?i)\b\d{1,2}x\d{1,3}\b",
            // `EP12`, `Episode 12`.
            r"(?i)\bep?(isode)?\s?\d{1,3}\b",
            // `第12話`.
            r"第\s?\d{1,4}\s?話",
            // Everything from the first quality or source marker onwards.
            r"(?i)\b\d{3,4}p\b",
            r"(?i)\b(bd|bluray|blu-ray|web-?dl|webrip|hdtv|dvdrip|x26[45]|hevc|aac|flac)\b",
        ]
        .iter()
        .filter_map(|pattern| regex::Regex::new(pattern).ok())
        .collect()
    })
}

fn pos_label(pos: PartOfSpeech) -> &'static str {
    match pos {
        PartOfSpeech::Noun => "noun",
        PartOfSpeech::Verb => "verb",
        PartOfSpeech::Adjective => "adjective",
        PartOfSpeech::Adverb => "adverb",
        PartOfSpeech::Particle => "particle",
        PartOfSpeech::AuxiliaryVerb => "auxiliary verb",
        PartOfSpeech::Conjunction => "conjunction",
        PartOfSpeech::Prefix => "prefix",
        PartOfSpeech::Interjection => "interjection",
        PartOfSpeech::Determiner => "determiner",
        PartOfSpeech::Symbol => "symbol",
        PartOfSpeech::Other => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::language::Script;
    use crate::model::{Token, TranscriptSource, ANALYSIS_VERSION};

    fn token(surface: &str, base: &str, pos: PartOfSpeech) -> Token {
        Token {
            surface: surface.into(),
            reading: String::new(),
            base: base.into(),
            pos,
            start: 0,
            end: surface.chars().count(),
            clickable: true,
        }
    }

    fn segment(id: usize, text: &str, tokens: Vec<Token>) -> Segment {
        Segment {
            id,
            start: id as f64,
            end: id as f64 + 1.0,
            text: text.into(),
            tokens,
            translation: String::new(),
            terms: Vec::new(),
        }
    }

    fn analysis(video_id: &str, script: Script, segments: Vec<Segment>) -> Analysis {
        Analysis {
            version: ANALYSIS_VERSION,
            video_id: video_id.into(),
            source: TranscriptSource::EmbeddedSubtitles,
            language: "ja".into(),
            script,
            segments,
            analyzed: false,
            whisper_model: String::new(),
            llm_model: String::new(),
            created_at: 0,
        }
    }

    fn entry(lemma: &str, count: u32, senses: &[&str]) -> VocabEntry {
        VocabEntry {
            info: WordInfo {
                lemma: lemma.into(),
                senses: senses.iter().map(|s| (*s).to_string()).collect(),
                ..Default::default()
            },
            count,
            sources: vec![WordSource {
                video_id: "v1".into(),
                title: "ep1".into(),
                series: "show".into(),
                count,
                last_seen: 0,
            }],
            examples: Vec::new(),
            first_seen: 0,
            last_seen: 0,
        }
    }

    /// The point of keying on `base`: two inflections are one vocabulary item.
    #[test]
    fn inflections_collapse_onto_one_dictionary_entry() {
        let subject = analysis(
            "v1",
            Script::Japanese,
            vec![
                segment(0, "食べた", vec![token("食べ", "食べる", PartOfSpeech::Verb)]),
                segment(1, "食べます", vec![token("食べ", "食べる", PartOfSpeech::Verb)]),
            ],
        );

        let seen = collect(&subject, "test");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen["食べる"].count, 2);
    }

    /// 食べ reads たべ; 食べる does not. Filing the surface's reading under the
    /// dictionary form would show a truncated reading in the word list.
    #[test]
    fn an_inflected_tokens_reading_is_not_filed_under_its_lemma() {
        let mut inflected = token("食べ", "食べる", PartOfSpeech::Verb);
        inflected.reading = "たべ".into();
        let subject = analysis(
            "v1",
            Script::Japanese,
            vec![segment(0, "食べた", vec![inflected])],
        );

        assert_eq!(collect(&subject, "test")["食べる"].reading, "");
    }

    #[test]
    fn an_uninflected_tokens_reading_is_kept() {
        let mut plain = token("猫", "猫", PartOfSpeech::Noun);
        plain.reading = "ねこ".into();
        let subject =
            analysis("v1", Script::Japanese, vec![segment(0, "猫", vec![plain])]);

        assert_eq!(collect(&subject, "test")["猫"].reading, "ねこ");
    }

    #[test]
    fn latin_and_digits_stay_out_of_the_log() {
        let subject = analysis(
            "v1",
            Script::Japanese,
            vec![segment(
                0,
                "OK です",
                vec![
                    token("OK", "OK", PartOfSpeech::Noun),
                    token("です", "です", PartOfSpeech::AuxiliaryVerb),
                ],
            )],
        );

        let seen = collect(&subject, "test");
        assert!(seen.contains_key("です"));
        assert!(!seen.contains_key("OK"), "latin tokens are not Japanese vocabulary");
    }

    /// Re-running an analysis is routine — forcing a regenerate, switching
    /// subtitle track, adding a key. None of it may inflate the counts.
    #[test]
    fn re_recording_a_video_replaces_its_counts_rather_than_adding() {
        let mut vocabulary = Vocabulary::default();
        let mut cat = entry("猫", 5, &[]);
        cat.sources.push(WordSource {
            video_id: "v2".into(),
            title: "ep2".into(),
            series: "show".into(),
            count: 3,
            last_seen: 0,
        });
        cat.count = 8;
        vocabulary.words.insert("猫".into(), cat);

        forget_video(&mut vocabulary, "v1");

        let cat = &vocabulary.words["猫"];
        assert_eq!(cat.count, 3, "only the other video's count should remain");
        assert_eq!(cat.sources.len(), 1);
    }

    /// Cached senses outlive the encounters that paid for them: forgetting a
    /// video must not throw away the definition it bought.
    #[test]
    fn forgetting_a_video_keeps_the_definition() {
        let mut vocabulary = Vocabulary::default();
        vocabulary.words.insert("猫".into(), entry("猫", 5, &["cat"]));

        forget_video(&mut vocabulary, "v1");

        let cat = &vocabulary.words["猫"];
        assert_eq!(cat.count, 0);
        assert!(cat.info.is_defined(), "the senses were paid for and must survive");
    }

    #[test]
    fn only_undefined_words_are_looked_up_again() {
        let mut vocabulary = Vocabulary::default();
        vocabulary.words.insert("猫".into(), entry("猫", 1, &["cat"]));
        // Met but never defined — the lookup pass still owes this one.
        vocabulary.words.insert("犬".into(), entry("犬", 1, &[]));

        assert!(is_defined(&vocabulary, "猫"));
        assert!(!is_defined(&vocabulary, "犬"));
        assert!(!is_defined(&vocabulary, "鳥"), "a word never met is not defined");
    }

    #[test]
    fn a_non_japanese_transcript_contributes_nothing() {
        let subject = analysis(
            "v1",
            Script::Chinese,
            vec![segment(0, "早上好", vec![token("早上", "早上", PartOfSpeech::Noun)])],
        );
        assert!(!subject.is_explainable());
    }

    #[test]
    fn examples_prefer_explained_lines_over_bare_ones() {
        let make = |text: &str, meaning: &str, translation: &str| WordExample {
            video_id: "v1".into(),
            title: "ep1".into(),
            start: 0.0,
            text: text.into(),
            surface: "猫".into(),
            translation: translation.into(),
            meaning: meaning.into(),
            grammar: String::new(),
        };
        let mut cat = entry("猫", 3, &[]);
        cat.examples.clear();

        merge_examples(
            &mut cat,
            vec![
                make("猫だ", "", ""),
                make("その猫はとても可愛いですね", "cat", "That cat is very cute"),
                make("猫がいる", "", "There is a cat"),
            ],
        );

        assert_eq!(cat.examples.len(), MAX_EXAMPLES_PER_VIDEO);
        assert_eq!(cat.examples[0].meaning, "cat");
        assert_eq!(cat.examples[1].translation, "There is a cat");
    }

    #[test]
    fn frequency_sort_ranks_by_encounters() {
        let mut vocabulary = Vocabulary::default();
        vocabulary.words.insert("あ".into(), entry("あ", 2, &[]));
        vocabulary.words.insert("い".into(), entry("い", 9, &["yes"]));

        let result =
            page(&vocabulary, &VocabQuery { sort: VocabSort::Frequency, ..Default::default() });

        assert_eq!(result.entries[0].info.lemma, "い");
        assert_eq!(result.total, 2);
        assert_eq!(result.total_encounters, 11);
        assert_eq!(result.undefined, 1, "あ is still waiting on the lookup pass");
    }

    #[test]
    fn a_definition_with_no_encounters_is_cache_not_log() {
        let mut vocabulary = Vocabulary::default();
        let mut ghost = entry("幽霊", 0, &["ghost"]);
        ghost.sources.clear();
        vocabulary.words.insert("幽霊".into(), ghost);

        let result = page(&vocabulary, &VocabQuery::default());
        assert!(result.entries.is_empty());
        assert_eq!(result.total_words, 0);
    }

    #[test]
    fn search_matches_the_word_its_reading_or_its_senses() {
        let mut cat = entry("猫", 1, &["cat", "feline"]);
        cat.info.reading = "ねこ".into();

        assert!(matches_search(&cat, "猫"));
        assert!(matches_search(&cat, "ねこ"));
        assert!(matches_search(&cat, "feline"));
        assert!(!matches_search(&cat, "dog"));
    }

    #[test]
    fn series_titles_survive_release_naming() {
        assert_eq!(series_title("[SubsPlease] Frieren - 12 (1080p) [A1B2].mkv"), "Frieren");
        assert_eq!(series_title("Show.Name.S01E02.1080p.WEB-DL.mkv"), "Show Name");
        assert_eq!(series_title("Sousou no Frieren 第12話.mkv"), "Sousou no Frieren");
        assert_eq!(series_title("My Anime EP05.mp4"), "My Anime");
        // Nothing recognisable to strip: the stem is the best answer available.
        assert_eq!(series_title("random clip.mkv"), "random clip");
    }

    /// The whole reason the guess exists — two episodes have to land in one
    /// bucket, or the dictionary's series filter is useless.
    #[test]
    fn episodes_of_one_series_group_together() {
        let first = series_title("[Group] Bocchi the Rock! - 01 [1080p][HEVC].mkv");
        let second = series_title("[Group] Bocchi the Rock! - 02 [1080p][HEVC].mkv");
        assert_eq!(first, second);
        assert_eq!(first, "Bocchi the Rock!");
    }

    #[test]
    fn kanji_frequency_sums_the_words_that_contain_it() {
        let mut vocabulary = Vocabulary::default();
        vocabulary.words.insert("人間".into(), entry("人間", 4, &[]));
        vocabulary.words.insert("一人".into(), entry("一人", 3, &[]));

        // 人 was read seven times: four in 人間 and three in 一人.
        let mut counts: HashMap<char, u32> = HashMap::new();
        for entry in vocabulary.words.values() {
            for ch in entry.info.lemma.chars().filter(|c| language::is_han(*c)) {
                *counts.entry(ch).or_default() += entry.count;
            }
        }
        assert_eq!(counts[&'人'], 7);
        assert_eq!(counts[&'間'], 4);
    }

    /// What the kanji panel is allowed to claim. A reading is attributed only
    /// where the word's own kana pin it to one character; everything else is
    /// the guess [`crate::furigana`] exists to refuse.
    #[test]
    fn a_reading_is_attributed_only_where_the_kana_pin_it_down() {
        assert_eq!(attributed_reading("食べる", "たべる", '食'), Some("た".into()));
        assert_eq!(attributed_reading("話す", "はなす", '話'), Some("はな".into()));
        // にほんご divides between 日, 本 and 語 in some way this app cannot
        // know, so none of the three gets a reading out of it.
        assert_eq!(attributed_reading("日本語", "にほんご", '日'), None);
        // A reading that is not this word's reading evidences nothing.
        assert_eq!(attributed_reading("食べる", "むちゃくちゃ", '食'), None);
    }

    #[test]
    fn a_character_used_twice_the_same_way_still_attributes() {
        assert_eq!(attributed_reading("生き生き", "いきいき", '生'), Some("い".into()));
    }

    #[test]
    fn the_log_round_trips_through_json() {
        let mut vocabulary = Vocabulary::default();
        vocabulary.words.insert("猫".into(), entry("猫", 3, &["cat", "feline"]));

        let encoded = serde_json::to_string(&vocabulary).expect("serializes");
        let decoded: Vocabulary = serde_json::from_str(&encoded).expect("round-trips");

        let cat = &decoded.words["猫"];
        assert_eq!(cat.count, 3);
        assert_eq!(cat.info.senses, vec!["cat", "feline"]);
        // `info` is flattened, so its fields must sit alongside `count` rather
        // than under an `info` key — the frontend mirror depends on that.
        assert!(encoded.contains("\"lemma\":\"猫\""));
        assert!(!encoded.contains("\"info\""));
    }
}

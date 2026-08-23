//! Turning the vocabulary log into Anki flashcards.
//!
//! Anki imports plain tab-separated text, and that is deliberately what this
//! writes rather than an `.apkg`. A real deck package is a zipped SQLite
//! database carrying its own note types, scheduling state, and media — writing
//! one would mean owning a schema that Anki changes on its own timetable, and
//! it would force *our* card design onto a collection the user has already set
//! up. A text file lets them map the columns onto whatever note type they
//! already study with, and it is the format Anki's own manual documents.
//!
//! The file leads with Anki's header directives (`#separator`, `#columns`,
//! `#tags column`), which is what makes the import a two-click affair instead
//! of a screen of dropdowns.
//!
//! Column order is the one the request asked for and the one a vocabulary card
//! wants: **word, reading, meaning, example, example translation**, with an
//! optional sixth column of tags that Anki files rather than shows.
//!
//! Rows come out most-frequent-first. Anki introduces new cards in the order
//! they were imported, so that ordering is not cosmetic: it means the words the
//! user actually keeps running into are the ones they see first.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::furigana;
use crate::model::{JlptLevel, VocabEntry, WordExample};
use crate::vocab;

/// The example length that reads best on a card: long enough to show the word
/// doing something, short enough to take in at a glance. Candidates are ranked
/// by distance from it, exactly as [`crate::vocab`] does when choosing which
/// lines to keep.
const IDEAL_EXAMPLE_CHARS: usize = 24;

/// Rows returned with the preview, so the dialog can show what a card will
/// actually look like rather than describing it.
const SAMPLE_ROWS: usize = 3;

/// Ceiling on the tags naming which series a word came from. A word met in
/// eight shows is a word met everywhere; listing all eight is noise.
const MAX_SERIES_TAGS: usize = 3;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/// The buckets a word can be exported by.
///
/// Coarser than [`crate::model::PartOfSpeech`] on purpose. This is not a
/// grammatical taxonomy, it is the question "which of these do I want on
/// flashcards?" — and the honest answer for most learners is nouns, verbs and
/// adjectives, sometimes adverbs, rarely particles (which are learned from
/// grammar rather than from cards).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordCategory {
    Noun,
    Verb,
    Adjective,
    Adverb,
    Particle,
    /// Conjunctions, interjections, counters, prefixes, set phrases, and
    /// anything the label did not identify.
    Other,
}

impl WordCategory {
    pub const ALL: [WordCategory; 6] = [
        Self::Noun,
        Self::Verb,
        Self::Adjective,
        Self::Adverb,
        Self::Particle,
        Self::Other,
    ];

    /// Sorts a part-of-speech label into a bucket.
    ///
    /// The labels come from two places and neither is a fixed vocabulary:
    /// Lindera writes `"noun"`, `"auxiliary verb"` and friends, while the
    /// dictionary pass writes whatever a language model considers a short
    /// label — `"godan verb"`, `"i-adjective"`, `"na-adjective"`,
    /// `"expression"`. Matching on substrings is therefore the only thing that
    /// works, and the order below is load-bearing: "adverb" contains "verb",
    /// and "adjectival noun" contains "noun".
    pub fn classify(label: &str) -> Self {
        let label = label.to_lowercase();
        if label.contains("adverb") {
            Self::Adverb
        } else if label.contains("adjectiv") || label.contains("adj") {
            Self::Adjective
        } else if label.contains("particle") {
            Self::Particle
        } else if label.contains("auxiliary") || label.contains("copula") {
            // A conjugating ending rather than a word to memorize.
            Self::Other
        } else if label.contains("verb") {
            Self::Verb
        } else if label.contains("noun") {
            // Includes "pronoun" and "proper noun", both of which are nouns to
            // anyone studying them.
            Self::Noun
        } else {
            Self::Other
        }
    }

    /// Lowercase name, used in the exported tag.
    fn slug(self) -> &'static str {
        match self {
            Self::Noun => "noun",
            Self::Verb => "verb",
            Self::Adjective => "adjective",
            Self::Adverb => "adverb",
            Self::Particle => "particle",
            Self::Other => "other",
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// What to export, mirrored by `AnkiOptions` in `src/lib/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnkiOptions {
    /// Which buckets to include. An empty list exports nothing, which is what
    /// clearing every checkbox visibly means — the alternative reading
    /// ("no filter, so everything") would export a thousand cards from a
    /// gesture that looks like it selected none.
    pub categories: Vec<WordCategory>,
    /// Keep only the N most frequent matches. Zero means no ceiling.
    pub limit: usize,
    /// Skip words met fewer than this many times.
    pub min_count: u32,
    /// Restrict to words met in one series. `None` is everything watched.
    pub series: Option<String>,
    /// Skip words the dictionary pass has not defined yet. On by default: a
    /// card with an empty back is not a card.
    pub require_meaning: bool,
    /// Write the reading as furigana notation (`日本[にほん]語[ご]`) rather
    /// than as plain kana.
    pub furigana: bool,
    /// Append a sixth column of tags for Anki to file the notes under.
    pub include_tags: bool,
}

impl Default for AnkiOptions {
    fn default() -> Self {
        Self {
            // Particles and the leftovers are off: they are the two buckets a
            // learner is least likely to want as cards, and they are also the
            // most frequent words in any transcript, so including them by
            // default would fill the first hundred rows with は and を.
            categories: vec![
                WordCategory::Noun,
                WordCategory::Verb,
                WordCategory::Adjective,
                WordCategory::Adverb,
            ],
            limit: 100,
            min_count: 1,
            series: None,
            require_meaning: true,
            furigana: true,
            include_tags: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/// One row of the export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard {
    pub word: String,
    /// Furigana notation or plain kana, depending on [`AnkiOptions::furigana`].
    pub reading: String,
    pub meaning: String,
    /// A line the word was actually met in. Empty when none was recorded.
    pub example: String,
    pub example_translation: String,
    pub tags: Vec<String>,
}

/// How many words the current options would produce, before writing anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiPreview {
    /// Rows that would be written, after the limit.
    pub cards: usize,
    /// Rows that matched before the limit, so the UI can say "100 of 812".
    pub matched: usize,
    /// Of the rows to be written, how many carry an example sentence.
    pub with_example: usize,
    /// Words excluded only because they have not been looked up yet.
    pub without_meaning: usize,
    /// How many words each bucket holds under the current scope, ignoring
    /// which buckets are selected — so the checkboxes can carry counts.
    pub counts: Vec<CategoryCount>,
    /// The first few rows, verbatim.
    pub sample: Vec<AnkiCard>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCount {
    pub category: WordCategory,
    pub words: usize,
}

/// The result of a completed export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiExport {
    pub path: String,
    pub cards: usize,
    pub with_example: usize,
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

struct Selection {
    cards: Vec<AnkiCard>,
    matched: usize,
    without_meaning: usize,
    counts: Vec<CategoryCount>,
}

/// Picks the words to export and renders each into a card.
fn select(app: &AppHandle, options: &AnkiOptions) -> Selection {
    vocab::with_words(app, |words| {
        let mut totals = [0usize; WordCategory::ALL.len()];
        let mut without_meaning = 0usize;
        let mut chosen: Vec<&VocabEntry> = Vec::new();

        for entry in words {
            // A word with no encounters is a cached definition, not something
            // the user has met — the same line the dictionary screen draws.
            if entry.count == 0 || entry.count < options.min_count {
                continue;
            }
            if let Some(series) = &options.series {
                if !entry.sources.iter().any(|source| &source.series == series) {
                    continue;
                }
            }
            if options.require_meaning && !entry.info.is_defined() {
                without_meaning += 1;
                continue;
            }

            let category = WordCategory::classify(&entry.info.part_of_speech);
            // Counted before the category filter, so each checkbox can show
            // what selecting it would add.
            if let Some(index) = WordCategory::ALL.iter().position(|c| *c == category) {
                totals[index] += 1;
            }
            if !options.categories.contains(&category) {
                continue;
            }
            chosen.push(entry);
        }

        chosen.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.info.lemma.cmp(&b.info.lemma))
        });

        let matched = chosen.len();
        if options.limit > 0 {
            chosen.truncate(options.limit);
        }

        Selection {
            cards: chosen.into_iter().map(|entry| card(entry, options)).collect(),
            matched,
            without_meaning,
            counts: WordCategory::ALL
                .iter()
                .enumerate()
                .map(|(index, category)| CategoryCount {
                    category: *category,
                    words: totals[index],
                })
                .collect(),
        }
    })
}

fn card(entry: &VocabEntry, options: &AnkiOptions) -> AnkiCard {
    let example = best_example(&entry.examples);

    AnkiCard {
        word: entry.info.lemma.clone(),
        reading: if options.furigana {
            furigana::write(&entry.info.lemma, &entry.info.reading)
        } else {
            entry.info.reading.clone()
        },
        meaning: meaning(entry),
        example: example.map(|e| e.text.clone()).unwrap_or_default(),
        example_translation: example.map(|e| e.translation.clone()).unwrap_or_default(),
        tags: if options.include_tags { tags(entry) } else { Vec::new() },
    }
}

/// The senses, plus the register note when there is one.
///
/// The note is the difference between knowing a word and using it wrongly —
/// "rude", "humble", "usually written in kana" — so it rides along in
/// parentheses rather than being dropped for tidiness.
fn meaning(entry: &VocabEntry) -> String {
    let senses = entry.info.senses.join("; ");
    let note = entry.info.note.trim();
    if note.is_empty() || senses.is_empty() {
        senses
    } else {
        format!("{senses} ({note})")
    }
}

/// The most useful of the recorded lines.
///
/// A line with a translation beats one without — the card has a field for it
/// and an empty field is a wasted one — then a line the breakdown explained,
/// then whichever is closest to a comfortable reading length.
fn best_example(examples: &[WordExample]) -> Option<&WordExample> {
    examples.iter().min_by_key(|example| {
        (
            example.translation.trim().is_empty(),
            example.meaning.trim().is_empty(),
            example.text.chars().count().abs_diff(IDEAL_EXAMPLE_CHARS),
        )
    })
}

/// Hierarchical tags, so the imported notes are findable and reversible.
///
/// Everything is nested under `ringo`, which means one search finds every card
/// this app ever produced — including, crucially, for deleting them again
/// after a botched import.
fn tags(entry: &VocabEntry) -> Vec<String> {
    let mut tags = vec!["ringo".to_string()];
    tags.push(format!(
        "ringo::pos::{}",
        WordCategory::classify(&entry.info.part_of_speech).slug()
    ));
    if let Some(level) = jlpt_tag(entry.info.jlpt_level) {
        tags.push(format!("ringo::jlpt::{level}"));
    }

    let mut series: Vec<(&str, u32)> = Vec::new();
    for source in &entry.sources {
        if source.series.trim().is_empty() {
            continue;
        }
        match series.iter_mut().find(|(name, _)| *name == source.series) {
            Some((_, count)) => *count += source.count,
            None => series.push((&source.series, source.count)),
        }
    }
    series.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    for (name, _) in series.into_iter().take(MAX_SERIES_TAGS) {
        tags.push(format!("ringo::series::{}", tag_slug(name)));
    }

    tags
}

fn jlpt_tag(level: JlptLevel) -> Option<&'static str> {
    match level {
        JlptLevel::N5 => Some("N5"),
        JlptLevel::N4 => Some("N4"),
        JlptLevel::N3 => Some("N3"),
        JlptLevel::N2 => Some("N2"),
        JlptLevel::N1 => Some("N1"),
        JlptLevel::None => None,
    }
}

/// Makes a series title usable as a tag.
///
/// Anki splits tags on whitespace, so a space in "Bocchi the Rock!" would
/// silently become three tags.
fn tag_slug(name: &str) -> String {
    name.split_whitespace()
        .map(|part| part.replace(['"', '\''], ""))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Renders the rows as the text file Anki's importer expects.
fn render(cards: &[AnkiCard], include_tags: bool) -> String {
    let mut out = String::new();

    // Anki 2.1.55 and later read these; older versions treat them as comments
    // and skip them, which is also the right outcome.
    out.push_str("#separator:tab\n");
    // Fields are plain text. Without this a meaning containing "<" would be
    // taken for markup and vanish from the card.
    out.push_str("#html:false\n");
    out.push_str("#columns:Word\tReading\tMeaning\tExample\tExample translation");
    if include_tags {
        out.push_str("\tTags");
    }
    out.push('\n');
    if include_tags {
        out.push_str("#tags column:6\n");
    }

    for card in cards {
        out.push_str(&field(&card.word));
        out.push('\t');
        out.push_str(&field(&card.reading));
        out.push('\t');
        out.push_str(&field(&card.meaning));
        out.push('\t');
        out.push_str(&field(&card.example));
        out.push('\t');
        out.push_str(&field(&card.example_translation));
        if include_tags {
            out.push('\t');
            out.push_str(&card.tags.join(" "));
        }
        out.push('\n');
    }

    out
}

/// Flattens a field to something a tab-separated line can hold.
///
/// Subtitle lines genuinely contain newlines — a two-line caption is one
/// segment — and a raw newline here would split one card into two broken ones.
fn field(text: &str) -> String {
    text.chars()
        .map(|ch| if ch == '\t' || ch == '\n' || ch == '\r' { ' ' } else { ch })
        .collect::<String>()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/// What the current options would export, without writing anything.
pub fn preview(app: &AppHandle, options: &AnkiOptions) -> AnkiPreview {
    let selection = select(app, options);

    AnkiPreview {
        cards: selection.cards.len(),
        matched: selection.matched,
        with_example: selection
            .cards
            .iter()
            .filter(|card| !card.example.trim().is_empty())
            .count(),
        without_meaning: selection.without_meaning,
        counts: selection.counts,
        sample: selection.cards.iter().take(SAMPLE_ROWS).cloned().collect(),
    }
}

/// Writes the export to `path`.
pub fn export(app: &AppHandle, options: &AnkiOptions, path: &Path) -> Result<AnkiExport> {
    let selection = select(app, options);
    if selection.cards.is_empty() {
        return Err(AppError::InvalidInput(
            "Nothing matches those options, so there is nothing to export.".into(),
        ));
    }

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(path, render(&selection.cards, options.include_tags))?;

    Ok(AnkiExport {
        path: path.to_string_lossy().into_owned(),
        cards: selection.cards.len(),
        with_example: selection
            .cards
            .iter()
            .filter(|card| !card.example.trim().is_empty())
            .count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_from_either_source_land_in_the_same_bucket() {
        // Lindera's labels.
        assert_eq!(WordCategory::classify("noun"), WordCategory::Noun);
        assert_eq!(WordCategory::classify("verb"), WordCategory::Verb);
        assert_eq!(WordCategory::classify("particle"), WordCategory::Particle);
        // The dictionary pass writes prose.
        assert_eq!(WordCategory::classify("godan verb"), WordCategory::Verb);
        assert_eq!(WordCategory::classify("i-adjective"), WordCategory::Adjective);
        assert_eq!(WordCategory::classify("na-adjective"), WordCategory::Adjective);
        assert_eq!(WordCategory::classify("proper noun"), WordCategory::Noun);
        assert_eq!(WordCategory::classify("expression"), WordCategory::Other);
        assert_eq!(WordCategory::classify(""), WordCategory::Other);
    }

    /// "adverb" ends in "verb" and "adjectival noun" ends in "noun". Both
    /// would be filed wrongly by a naive check, and both are common labels.
    #[test]
    fn substring_collisions_resolve_to_the_more_specific_bucket() {
        assert_eq!(WordCategory::classify("adverb"), WordCategory::Adverb);
        assert_eq!(WordCategory::classify("adjectival noun"), WordCategory::Adjective);
        assert_eq!(WordCategory::classify("auxiliary verb"), WordCategory::Other);
    }

    fn sample_card() -> AnkiCard {
        AnkiCard {
            word: "猫".into(),
            reading: "猫[ねこ]".into(),
            meaning: "cat".into(),
            // A two-line caption is one segment, newline and all.
            example: "その猫は\nとても可愛い".into(),
            example_translation: "That cat is very cute".into(),
            tags: vec!["ringo".into(), "ringo::pos::noun".into()],
        }
    }

    #[test]
    fn a_row_is_five_fields_plus_optional_tags() {
        let with_tags = render(&[sample_card()], true);
        let row = with_tags.lines().last().expect("one row");
        assert_eq!(row.split('\t').count(), 6);
        assert!(with_tags.contains("#tags column:6"));

        let without = render(&[sample_card()], false);
        let row = without.lines().last().expect("one row");
        assert_eq!(row.split('\t').count(), 5);
        assert!(!without.contains("#tags column"));
    }

    /// A raw newline inside a field would end the row early and turn one card
    /// into two unusable ones.
    #[test]
    fn newlines_inside_a_field_cannot_break_the_row() {
        let rendered = render(&[sample_card()], true);
        // Four header lines plus exactly one row.
        assert_eq!(rendered.lines().count(), 5);
        assert!(rendered.contains("その猫は とても可愛い"));
    }

    #[test]
    fn the_header_declares_the_format_anki_should_read() {
        let rendered = render(&[], true);
        assert!(rendered.starts_with("#separator:tab\n"));
        assert!(rendered.contains("#html:false"));
        assert!(rendered.contains("#columns:Word\tReading\tMeaning"));
    }

    #[test]
    fn series_titles_survive_becoming_tags() {
        // Anki splits tags on whitespace, so the spaces have to go.
        assert_eq!(tag_slug("Bocchi the Rock!"), "Bocchi_the_Rock!");
        assert_eq!(tag_slug("  Frieren  "), "Frieren");
    }

    #[test]
    fn the_default_selection_is_content_words_only() {
        let options = AnkiOptions::default();
        assert!(options.categories.contains(&WordCategory::Noun));
        assert!(options.categories.contains(&WordCategory::Verb));
        assert!(
            !options.categories.contains(&WordCategory::Particle),
            "particles are the most frequent words in any transcript and the \
             least useful as cards; including them by default would fill the \
             first hundred rows with は and を"
        );
    }

    /// Missing fields come from `Default`, not from `Vec::new()` and `0` —
    /// otherwise a settings file written by an older build would export
    /// nothing at all.
    #[test]
    fn options_from_an_older_payload_keep_the_defaults() {
        let options: AnkiOptions = serde_json::from_str("{}").expect("parses");
        assert_eq!(options.limit, 100);
        assert!(options.furigana);
        assert!(!options.categories.is_empty());
    }
}

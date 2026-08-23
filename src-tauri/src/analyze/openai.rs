//! The in-context pass: what each line means, and what its words are doing.
//!
//! Ported from the Go backend this app replaces, and it keeps that design's
//! most important property: **the model never sees or returns a timestamp**.
//! Segments go out as `{id, text}` and come back as `{id, translation,
//! terms}`, and the merge happens here against timings we already know are
//! correct. A model asked to echo numbers it cannot verify will eventually
//! change one.
//!
//! What is new is batching, and the split with [`super::dictionary`]. This
//! pass answers only the questions that depend on the sentence — which of a
//! word's senses is meant here, how the grammar is put together, what the
//! contraction is short for. The senses themselves come from the cache, so
//! nothing context-free is ever paid for twice. That also means this pass is
//! always regenerated: its answers are only true of the line they came from.

use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::model::{Segment, Term};
use crate::settings::Settings;

use super::client;
use super::dictionary::parse_level;

/// Lines of surrounding context included with each batch.
///
/// Without it the first line of every batch is explained with no idea what
/// preceded it, which matters in Japanese where the subject is usually
/// omitted and carried over from earlier dialogue. These lines are sent for
/// reading but are not requested back.
const CONTEXT_LINES: usize = 4;

/// Header of the read-only context block. Distinct from the phrase "CONTEXT
/// ONLY" used in [`INSTRUCTIONS`], so tests can tell the block apart from the
/// sentence that describes it.
const CONTEXT_HEADER: &str = "PRECEDING CONTEXT (do not return entries for these):";

/// The task description handed to the model. Kept close to the original Go
/// prompt — it was tuned against real transcripts — with the dictionary half
/// removed, since that now comes from the vocabulary cache.
const INSTRUCTIONS: &str = "You are a Japanese language tutor helping an intermediate learner \
understand a video transcript.

Below is the video's title for context, then a numbered list of transcript segments.

For EVERY segment in the SEGMENTS TO EXPLAIN list, provide:
- a natural, idiomatic English translation
- a list of terms: the words and grammar this line is built from.

Be generous about what earns a term. Cover every content word (noun, verb,
adjective, adverb), every grammar pattern, every idiom, contraction, and
sentence-final particle that is doing real work. You may skip a bare topic or
object particle when it is behaving completely ordinarily. It is better to
explain a word the learner already knew than to leave one unexplained.

For each term give:
- term: the DICTIONARY form -- 食べる, not 食べちゃった
- reading: the reading in hiragana
- meaning: what the word means IN THIS LINE. This is the sense it carries
  here, not a list of everything it can mean elsewhere: if 気 is being used as
  \"mood\" in this sentence, say \"mood (here)\", not \"spirit/mind/feeling\".
  Keep it to a few words.
- grammar: how it is put together and what it is doing here -- the
  conjugation and what that conjugation means (\"past casual of 食べる\",
  \"て-form joining to the next clause\", \"volitional: let's ...\"), or the
  particle's job in this sentence (\"marks 猫 as the object\"). Leave empty
  for a plain uninflected noun where there is nothing to say.
- jlpt_level: approximate level, or \"none\"
- note: ONLY if something non-obvious is happening -- slang, idiom, cultural
  reference, a casual contraction of a longer form, unusual register.
  Otherwise leave it empty.

This is spoken dialogue from animation, so expect casual speech, contractions,
sentence-final particles, and role language. Explain those as they are used
rather than correcting them to textbook forms.

Each term must be a SINGLE dictionary-lookupable unit: one word, one compound,
one particle, or one fixed grammar pattern. Never return a whole clause or
sentence fragment as a term. Prefer several short terms over one long one --
\"嘘\", \"つく\", \"の\", \"下手\", \"よね\" rather than \"嘘つくの下手だよね\".

Some segments appear under a PRECEDING CONTEXT heading. Read them to understand
what is being discussed, but do NOT return entries for them.

Preserve each segment's id exactly as given. Do not skip, merge, or reorder segments.
Do not invent timestamps -- none are given to you and none are expected back.";

/// The shape the model is structurally constrained to emit.
///
/// `strict` mode requires every property to appear in `required` and
/// `additionalProperties: false` at each level, which is why optional-feeling
/// fields like `note` are mandatory-but-empty rather than absent.
fn response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "description": "One entry per segment in SEGMENTS TO EXPLAIN, same order",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "integer",
                            "description": "The segment id from the input, unchanged"
                        },
                        "translation": {
                            "type": "string",
                            "description": "Natural, idiomatic English translation of the segment"
                        },
                        "terms": {
                            "type": "array",
                            "description": "The words and grammar this line is built from",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "term": {
                                        "type": "string",
                                        "description": "Dictionary form of the word or pattern"
                                    },
                                    "reading": { "type": "string", "description": "Hiragana reading" },
                                    "meaning": {
                                        "type": "string",
                                        "description": "The sense this word carries in THIS line, in a few words"
                                    },
                                    "grammar": {
                                        "type": "string",
                                        "description": "Conjugation or particle function here, empty if there is nothing to say"
                                    },
                                    "jlpt_level": {
                                        "type": "string",
                                        "enum": ["N5", "N4", "N3", "N2", "N1", "none"]
                                    },
                                    "note": {
                                        "type": "string",
                                        "description": "Slang/nuance/cultural context if relevant, else empty string"
                                    }
                                },
                                "required": ["term", "reading", "meaning", "grammar", "jlpt_level", "note"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["id", "translation", "terms"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["segments"],
        "additionalProperties": false
    })
}

#[derive(Debug, Deserialize)]
struct BreakdownResponse {
    #[serde(default)]
    segments: Vec<BreakdownSegment>,
}

#[derive(Debug, Deserialize)]
struct BreakdownSegment {
    id: usize,
    #[serde(default)]
    translation: String,
    #[serde(default)]
    terms: Vec<WireTerm>,
}

/// The model's term shape. Snake-case on the wire, converted to [`Term`] at
/// the boundary so the provider's naming never reaches the UI.
#[derive(Debug, Deserialize)]
struct WireTerm {
    #[serde(default)]
    term: String,
    #[serde(default)]
    reading: String,
    #[serde(default)]
    meaning: String,
    #[serde(default)]
    grammar: String,
    #[serde(default)]
    jlpt_level: String,
    #[serde(default)]
    note: String,
}

impl From<WireTerm> for Term {
    fn from(raw: WireTerm) -> Self {
        Term {
            term: raw.term,
            reading: raw.reading,
            meaning: raw.meaning,
            grammar: raw.grammar,
            jlpt_level: parse_level(&raw.jlpt_level),
            note: raw.note,
        }
    }
}

/// Fills in translations and terms across every segment.
///
/// Batches run concurrently and each is retried independently. A batch that
/// still fails after its retries is *skipped*, not fatal: 90% of an episode
/// explained is far more useful than an error, and the frontend shows which
/// lines came back empty. `on_progress` receives (completed_batches,
/// total_batches).
pub async fn analyze<F>(
    settings: &Settings,
    api_key: &str,
    title: &str,
    segments: &mut [Segment],
    on_progress: F,
) -> Result<usize>
where
    F: Fn(usize, usize) + Send + Sync,
{
    if segments.is_empty() {
        return Ok(0);
    }

    let client = client::build()?;

    // Index ranges rather than slices, so the immutable read for building
    // requests and the mutable write for merging results don't overlap.
    let batches: Vec<(usize, usize)> = (0..segments.len())
        .step_by(settings.batch_size)
        .map(|start| (start, (start + settings.batch_size).min(segments.len())))
        .collect();
    let total = batches.len();

    // The batch's own id range travels with its prompt, because the merge
    // below needs it — see there.
    let prompts: Vec<(usize, (usize, usize), String)> = batches
        .iter()
        .enumerate()
        .map(|(i, &(start, end))| (i, (start, end), build_prompt(title, segments, start, end)))
        .collect();

    let completed = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<Option<(Vec<usize>, Vec<BreakdownSegment>)>> =
        futures::stream::iter(prompts)
            .map(|(index, (start, end), prompt)| {
                let client = &client;
                let completed = &completed;
                let on_progress = &on_progress;
                // The ids this batch was actually asked about, so its answers
                // can be told apart from echoes of its context block.
                let asked: Vec<usize> = segments[start..end].iter().map(|s| s.id).collect();
                async move {
                    let outcome = match request(client, settings, api_key, &prompt).await {
                        Ok(parsed) => Some((asked, parsed.segments)),
                        Err(err) => {
                            log::warn!("breakdown batch {index} failed and was skipped: {err}");
                            None
                        }
                    };
                    let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    on_progress(done, total);
                    outcome
                }
            })
            .buffer_unordered(settings.concurrency)
            .collect()
            .await;

    let filled = merge(segments, results.into_iter().flatten());

    if filled == 0 {
        return Err(AppError::OpenAi(
            "No segments could be explained. Check the API key and your connection.".into(),
        ));
    }
    Ok(filled)
}

/// Folds finished batches back into the transcript, returning how many
/// segments came back explained.
///
/// Only ids a batch was *asked* about are taken from it. Every prompt carries
/// the preceding [`CONTEXT_LINES`] for the model to read and tells it not to
/// return entries for them; models do it anyway. Such an echo is an answer to
/// a line that batch was never asked about — written without that line's own
/// surrounding batch — and letting one in would overwrite the real entry from
/// the batch that owned it. Which of the two won used to come down to which
/// request happened to finish first, since `buffer_unordered` yields in
/// completion order rather than in index order.
///
/// Anything the model omitted simply stays empty, which the UI renders as
/// "not explained" rather than as a wrong translation.
fn merge(
    segments: &mut [Segment],
    batches: impl Iterator<Item = (Vec<usize>, Vec<BreakdownSegment>)>,
) -> usize {
    let mut by_id: std::collections::HashMap<usize, BreakdownSegment> =
        std::collections::HashMap::new();
    for (asked, entries) in batches {
        let asked: std::collections::HashSet<usize> = asked.into_iter().collect();
        for entry in entries {
            if asked.contains(&entry.id) {
                by_id.insert(entry.id, entry);
            }
        }
    }

    let mut filled = 0usize;
    for segment in segments.iter_mut() {
        if let Some(entry) = by_id.remove(&segment.id) {
            segment.translation = entry.translation;
            segment.terms = entry.terms.into_iter().map(Term::from).collect();
            filled += 1;
        }
    }
    filled
}

async fn request(
    client: &reqwest::Client,
    settings: &Settings,
    api_key: &str,
    prompt: &str,
) -> Result<BreakdownResponse> {
    let content = client::json(
        client,
        settings,
        api_key,
        prompt,
        "transcript_breakdown",
        response_schema(),
    )
    .await?;

    serde_json::from_str(&content)
        .map_err(|err| AppError::OpenAi(format!("could not parse the breakdown: {err}")))
}

/// Renders one batch, with preceding lines marked as read-only context.
fn build_prompt(title: &str, segments: &[Segment], start: usize, end: usize) -> String {
    let context_start = start.saturating_sub(CONTEXT_LINES);

    let mut prompt = String::with_capacity(4096);
    prompt.push_str(INSTRUCTIONS);
    prompt.push_str("\n\nTitle: ");
    prompt.push_str(title);

    if context_start < start {
        prompt.push_str("\n\n");
        prompt.push_str(CONTEXT_HEADER);
        prompt.push('\n');
        let context: Vec<Value> = segments[context_start..start]
            .iter()
            .map(|s| json!({ "id": s.id, "text": s.text }))
            .collect();
        prompt.push_str(&serde_json::to_string(&context).unwrap_or_default());
    }

    prompt.push_str("\n\nSEGMENTS TO EXPLAIN:\n");
    let batch: Vec<Value> = segments[start..end]
        .iter()
        .map(|s| json!({ "id": s.id, "text": s.text }))
        .collect();
    prompt.push_str(&serde_json::to_string(&batch).unwrap_or_default());
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::JlptLevel;

    fn segment(id: usize, text: &str) -> Segment {
        Segment {
            id,
            start: id as f64,
            end: id as f64 + 1.0,
            text: text.into(),
            tokens: Vec::new(),
            translation: String::new(),
            terms: Vec::new(),
        }
    }

    #[test]
    fn prompt_carries_ids_and_text_but_never_timestamps() {
        let segments = vec![segment(0, "おはよう"), segment(1, "こんばんは")];
        let prompt = build_prompt("Test", &segments, 0, 2);

        assert!(prompt.contains("\"id\":0"));
        assert!(prompt.contains("おはよう"));
        // Timing fields must not leak into the request.
        assert!(!prompt.contains("start"));
        assert!(!prompt.contains("\"end\""));
    }

    #[test]
    fn later_batches_include_preceding_lines_as_context_only() {
        let segments: Vec<Segment> = (0..12).map(|i| segment(i, "テスト")).collect();
        let prompt = build_prompt("Test", &segments, 8, 12);

        assert!(prompt.contains(CONTEXT_HEADER));
        // Four lines of lookback, so ids 4..8 precede the batch itself.
        assert!(prompt.contains("\"id\":4"));
        assert!(prompt.contains("SEGMENTS TO EXPLAIN"));
    }

    #[test]
    fn first_batch_has_no_context_block() {
        let segments: Vec<Segment> = (0..12).map(|i| segment(i, "テスト")).collect();
        assert!(!build_prompt("Test", &segments, 0, 4).contains(CONTEXT_HEADER));
    }

    /// The division of labour between the two passes, stated as a test: this
    /// prompt asks for the contextual sense and never for a sense list.
    #[test]
    fn the_prompt_asks_for_the_contextual_sense_and_the_grammar() {
        let prompt = build_prompt("Test", &[segment(0, "テスト")], 0, 1);
        assert!(prompt.contains("IN THIS LINE"));
        assert!(prompt.contains("conjugation"));
        assert!(prompt.contains("DICTIONARY form"));
    }

    #[test]
    fn unknown_jlpt_levels_degrade_to_none() {
        let term: Term = WireTerm {
            term: "猫".into(),
            reading: "ねこ".into(),
            meaning: "cat".into(),
            grammar: String::new(),
            jlpt_level: "N9".into(),
            note: String::new(),
        }
        .into();
        assert_eq!(term.jlpt_level, JlptLevel::None);
    }

    fn wire(id: usize, translation: &str) -> BreakdownSegment {
        BreakdownSegment { id, translation: translation.into(), terms: Vec::new() }
    }

    /// The bug this exists to prevent: the prompt for batch two carries the
    /// tail of batch one as read-only context, and a model that echoes an
    /// entry for one of those lines used to be able to overwrite the real
    /// answer batch one had already produced for it — nondeterministically,
    /// since `buffer_unordered` yields in completion order.
    #[test]
    fn a_batch_cannot_answer_for_a_line_it_only_read_as_context() {
        let mut segments = vec![segment(0, "A"), segment(1, "B"), segment(2, "C")];

        let first = (vec![0, 1], vec![wire(0, "first"), wire(1, "second")]);
        // Batch two was asked only about id 2, but also echoed id 1 back.
        let second = (vec![2], vec![wire(1, "echoed from context"), wire(2, "third")]);

        let filled = merge(&mut segments, [second, first].into_iter());

        assert_eq!(filled, 3);
        assert_eq!(segments[1].translation, "second", "the owning batch wins");
        assert_eq!(segments[0].translation, "first");
        assert_eq!(segments[2].translation, "third");
    }

    #[test]
    fn an_invented_id_is_dropped_rather_than_stored() {
        let mut segments = vec![segment(0, "A")];
        let filled = merge(&mut segments, [(vec![0], vec![wire(0, "real"), wire(99, "invented")])].into_iter());
        assert_eq!(filled, 1);
        assert_eq!(segments[0].translation, "real");
    }

    #[test]
    fn a_segment_no_batch_answered_stays_empty() {
        let mut segments = vec![segment(0, "A"), segment(1, "B")];
        let filled = merge(&mut segments, [(vec![0, 1], vec![wire(0, "only this one")])].into_iter());
        assert_eq!(filled, 1);
        assert_eq!(segments[1].translation, "", "unexplained reads as unexplained");
    }

    #[test]
    fn schema_is_strict_at_every_level() {
        let schema = response_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        let items = &schema["properties"]["segments"]["items"];
        assert_eq!(items["additionalProperties"], json!(false));
        assert_eq!(items["properties"]["terms"]["items"]["additionalProperties"], json!(false));
        // `grammar` is required, not optional: strict mode rejects a schema
        // whose properties and `required` list disagree.
        let term = &items["properties"]["terms"]["items"];
        assert_eq!(term["required"].as_array().unwrap().len(), 6);
    }
}

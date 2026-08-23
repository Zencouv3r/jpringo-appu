//! The dictionary pass: what each word means, out of context.
//!
//! This is the half of the breakdown that never changes. 猫 is "cat" in every
//! episode of every series, so it is asked for once, written to
//! [`crate::vocab`], and never paid for again — which is what makes "a
//! translation for every word" affordable at all. On the first episode of a
//! series this looks up a thousand-odd lemmas; on the second it looks up the
//! couple of hundred that are new.
//!
//! Words are sent as a bare list, deliberately without their sentences. A
//! sense list that depended on the line it came from would not be reusable,
//! which is the entire point of the cache. The in-context reading of a word is
//! the other pass's job — see [`super::openai`].

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::Result;
use crate::model::{JlptLevel, WordInfo};
use crate::settings::Settings;

use super::client;

/// Words per request.
///
/// Bigger than the line batches because each entry is far smaller: sixty words
/// is roughly the same output size as forty explained transcript lines, and
/// fewer round trips means the whole pass finishes in a handful of requests.
const BATCH_SIZE: usize = 60;

/// Ceiling on how many words one video may look up.
///
/// A pathological transcript — badly tokenized whisper output, mostly proper
/// nouns — could otherwise turn into hundreds of requests. The list is ordered
/// by frequency, so the words that fall off the end are the ones seen once.
const MAX_LOOKUPS: usize = 3000;

const INSTRUCTIONS: &str = "You are compiling a Japanese-English dictionary for an \
intermediate learner.

Below is a list of Japanese words in dictionary form. For EVERY word, return:
- reading: the reading in hiragana (katakana words keep katakana)
- senses: one to three short English translations, most common first. Give
  genuinely distinct senses, not restatements of each other -- 気 is \"spirit\",
  \"mind\", \"feeling\", while 猫 is just \"cat\". A word with one meaning gets
  one sense.
- part_of_speech: a short label such as \"noun\", \"godan verb\", \"i-adjective\",
  \"na-adjective\", \"particle\", \"adverb\", \"expression\", \"suffix\"
- jlpt_level: the approximate level, or \"none\" if it is not on any list
- note: a SHORT usage note only when one is genuinely needed -- register
  (casual, humble, rude), \"usually written in kana\", \"mainly in fiction\",
  a name or a place. Otherwise leave it empty.

These are context-free dictionary entries: describe what the word means in
general, not how it might be used in any particular sentence.

Echo each `word` back exactly as it was given, including any inflection or \
unusual spelling. Do not skip words, do not merge them, and do not add words \
that were not in the list. If a word is a proper noun, a fragment, or something \
you cannot identify, still return it with your best guess and an empty or \
\"none\" level rather than dropping it.";

fn response_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "words": {
                "type": "array",
                "description": "One entry per input word, same order",
                "items": {
                    "type": "object",
                    "properties": {
                        "word": {
                            "type": "string",
                            "description": "The input word, echoed exactly"
                        },
                        "reading": { "type": "string", "description": "Hiragana reading" },
                        "senses": {
                            "type": "array",
                            "description": "One to three distinct English meanings, most common first",
                            "items": { "type": "string" }
                        },
                        "part_of_speech": { "type": "string" },
                        "jlpt_level": {
                            "type": "string",
                            "enum": ["N5", "N4", "N3", "N2", "N1", "none"]
                        },
                        "note": {
                            "type": "string",
                            "description": "Register or usage note if needed, else empty string"
                        }
                    },
                    "required": ["word", "reading", "senses", "part_of_speech", "jlpt_level", "note"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["words"],
        "additionalProperties": false
    })
}

#[derive(Debug, Deserialize)]
struct LookupResponse {
    #[serde(default)]
    words: Vec<WireWord>,
}

#[derive(Debug, Deserialize)]
struct WireWord {
    #[serde(default)]
    word: String,
    #[serde(default)]
    reading: String,
    #[serde(default)]
    senses: Vec<String>,
    #[serde(default)]
    part_of_speech: String,
    #[serde(default)]
    jlpt_level: String,
    #[serde(default)]
    note: String,
}

impl From<WireWord> for WordInfo {
    fn from(raw: WireWord) -> Self {
        WordInfo {
            lemma: raw.word,
            reading: raw.reading,
            // Trimmed and de-duplicated here rather than trusted: an empty
            // sense would be cached as a definition and never asked for again.
            senses: dedupe(raw.senses),
            part_of_speech: raw.part_of_speech,
            jlpt_level: parse_level(&raw.jlpt_level),
            note: raw.note,
        }
    }
}

fn dedupe(senses: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(senses.len());
    for sense in senses {
        let sense = sense.trim().to_string();
        if sense.is_empty() || out.iter().any(|kept| kept.eq_ignore_ascii_case(&sense)) {
            continue;
        }
        out.push(sense);
    }
    out
}

pub fn parse_level(raw: &str) -> JlptLevel {
    match raw {
        "N5" => JlptLevel::N5,
        "N4" => JlptLevel::N4,
        "N3" => JlptLevel::N3,
        "N2" => JlptLevel::N2,
        "N1" => JlptLevel::N1,
        _ => JlptLevel::None,
    }
}

/// Looks up every word in `lemmas`, in frequency order.
///
/// A batch that fails after its retries is skipped rather than fatal: those
/// words simply stay undefined and are looked up on the next run, which is a
/// far better outcome than failing the whole pass over one bad request.
/// `on_progress` receives (completed batches, total batches).
pub async fn lookup<F>(
    settings: &Settings,
    api_key: &str,
    lemmas: &[String],
    on_progress: F,
) -> Result<Vec<WordInfo>>
where
    F: Fn(usize, usize) + Send + Sync,
{
    if lemmas.is_empty() {
        return Ok(Vec::new());
    }

    let lemmas = &lemmas[..lemmas.len().min(MAX_LOOKUPS)];
    let client = client::build()?;

    let prompts: Vec<String> = lemmas.chunks(BATCH_SIZE).map(build_prompt).collect();
    let total = prompts.len();
    let completed = std::sync::atomic::AtomicUsize::new(0);

    use futures::StreamExt;
    let batches: Vec<Vec<WordInfo>> = futures::stream::iter(prompts.into_iter().enumerate())
        .map(|(index, prompt)| {
            let client = &client;
            let completed = &completed;
            let on_progress = &on_progress;
            async move {
                let words = match client::json(
                    client,
                    settings,
                    api_key,
                    &prompt,
                    "word_definitions",
                    response_schema(),
                )
                .await
                .and_then(|content| {
                    serde_json::from_str::<LookupResponse>(&content).map_err(|err| {
                        crate::error::AppError::OpenAi(format!(
                            "could not parse the word definitions: {err}"
                        ))
                    })
                }) {
                    Ok(parsed) => parsed.words.into_iter().map(WordInfo::from).collect(),
                    Err(err) => {
                        log::warn!("dictionary batch {index} failed and was skipped: {err}");
                        Vec::new()
                    }
                };
                let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                on_progress(done, total);
                words
            }
        })
        .buffer_unordered(settings.concurrency)
        .collect()
        .await;

    // Anything the model invented, echoed wrong, or returned empty is dropped:
    // only words that were actually asked about may enter the cache, or a
    // hallucinated lemma would be cached forever.
    let requested: std::collections::HashSet<&str> = lemmas.iter().map(String::as_str).collect();
    Ok(batches
        .into_iter()
        .flatten()
        .filter(|info| info.is_defined() && requested.contains(info.lemma.as_str()))
        .collect())
}

fn build_prompt(batch: &[String]) -> String {
    let words: Vec<Value> = batch.iter().map(|lemma| json!({ "word": lemma })).collect();

    let mut prompt = String::with_capacity(1024 + batch.len() * 12);
    prompt.push_str(INSTRUCTIONS);
    prompt.push_str("\n\nWORDS:\n");
    prompt.push_str(&serde_json::to_string(&words).unwrap_or_default());
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_carries_only_words() {
        let prompt = build_prompt(&["猫".to_string(), "食べる".to_string()]);
        assert!(prompt.contains("\"word\":\"猫\""));
        assert!(prompt.contains("食べる"));
        // No sentences travel with them: a sense that depended on one would
        // not be cacheable, which is the entire reason this pass is separate.
        assert!(!prompt.contains("\"text\""));
        assert!(prompt.contains("context-free dictionary entries"));
    }

    #[test]
    fn duplicate_and_empty_senses_are_dropped() {
        let info: WordInfo = WireWord {
            word: "猫".into(),
            reading: "ねこ".into(),
            senses: vec!["cat".into(), "  ".into(), "Cat".into(), "feline".into()],
            part_of_speech: "noun".into(),
            jlpt_level: "N5".into(),
            note: String::new(),
        }
        .into();
        assert_eq!(info.senses, vec!["cat", "feline"]);
    }

    #[test]
    fn a_word_with_no_senses_is_not_cacheable() {
        let info: WordInfo = WireWord {
            word: "???".into(),
            reading: String::new(),
            senses: vec![String::new()],
            part_of_speech: String::new(),
            jlpt_level: "none".into(),
            note: String::new(),
        }
        .into();
        // Caching this would mean never looking the word up again.
        assert!(!info.is_defined());
    }

    #[test]
    fn unknown_jlpt_levels_degrade_to_none() {
        assert_eq!(parse_level("N9"), JlptLevel::None);
        assert_eq!(parse_level("N5"), JlptLevel::N5);
    }

    #[test]
    fn the_schema_is_strict_at_every_level() {
        let schema = response_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["properties"]["words"]["items"]["additionalProperties"], json!(false));
    }
}

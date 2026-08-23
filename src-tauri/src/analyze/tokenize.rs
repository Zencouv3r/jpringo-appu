//! Splitting Japanese text into clickable words.
//!
//! Japanese is written without spaces, so "click a word to see what it means"
//! is not a UI problem — it is a morphological analysis problem. Lindera with
//! IPADIC does the segmentation and, as a side effect, hands back the reading
//! and dictionary form of each token, which is exactly what the word panel
//! needs to show before any network call happens.
//!
//! The dictionary is compiled into the binary (`embed-ipadic`), so this works
//! offline and needs no data directory.

use std::borrow::Cow;
use std::sync::OnceLock;

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;

use crate::model::{PartOfSpeech, Segment, Token};

/// IPADIC feature column indices. The dictionary emits nine comma-separated
/// fields per entry and these are the three that matter here.
const IDX_POS: usize = 0;
const IDX_BASE_FORM: usize = 6;
const IDX_READING: usize = 7;

/// Loading and indexing the dictionary takes long enough to be worth doing
/// once. `Segmenter::segment` takes `&self`, so a shared instance is safe to
/// use from every worker.
fn segmenter() -> Option<&'static Segmenter> {
    static SEGMENTER: OnceLock<Option<Segmenter>> = OnceLock::new();
    SEGMENTER
        .get_or_init(|| match load_dictionary("embedded://ipadic") {
            Ok(dictionary) => Some(Segmenter::new(Mode::Normal, dictionary, None)),
            Err(err) => {
                log::error!("could not load the IPADIC dictionary: {err}");
                None
            }
        })
        .as_ref()
}

/// Tokenizes every segment in place.
///
/// Failure is not fatal. Without tokens the transcript still renders and every
/// translation still works; only per-word clicking is lost, which is a
/// degraded feature rather than a broken app.
pub fn annotate(segments: &mut [Segment]) {
    let Some(segmenter) = segmenter() else {
        return;
    };
    for segment in segments {
        segment.tokens = tokenize(segmenter, &segment.text);
    }
}

fn tokenize(segmenter: &Segmenter, text: &str) -> Vec<Token> {
    let Ok(mut raw) = segmenter.segment(Cow::Borrowed(text)) else {
        return Vec::new();
    };

    // Lindera reports byte offsets; the frontend indexes into a JavaScript
    // string. Precomputing the mapping keeps the conversion linear instead of
    // re-scanning the text for every token.
    let char_index = byte_to_char_index(text);

    raw.iter_mut()
        .filter_map(|token| {
            // Everything read off the token is copied out before `details()`,
            // which takes `&mut self` and would otherwise hold the borrow for
            // the rest of the closure.
            let surface = token.surface.to_string();
            let (byte_start, byte_end) = (token.byte_start, token.byte_end);
            if surface.trim().is_empty() {
                return None;
            }

            let details = token.details();
            // `*` is IPADIC's "not applicable" marker and `UNK` marks a word
            // the dictionary has never seen; both mean "no value here".
            let field = |i: usize| -> Option<&str> {
                details
                    .get(i)
                    .copied()
                    .filter(|v| !v.is_empty() && *v != "*" && *v != "UNK")
            };

            let pos = field(IDX_POS).map_or(PartOfSpeech::Other, PartOfSpeech::from_ipadic);
            let base = field(IDX_BASE_FORM).unwrap_or(surface.as_str()).to_string();
            let reading = field(IDX_READING).map(katakana_to_hiragana).unwrap_or_default();

            Some(Token {
                start: *char_index.get(byte_start)?,
                end: *char_index.get(byte_end)?,
                clickable: pos.is_clickable() && surface.chars().any(is_worth_clicking),
                surface,
                reading,
                base,
                pos,
            })
        })
        .collect()
}

/// Maps every byte offset in `text` to its character offset, with one extra
/// entry so a token's exclusive end offset resolves.
fn byte_to_char_index(text: &str) -> Vec<usize> {
    let mut index = vec![0usize; text.len() + 1];
    let mut chars = 0usize;
    for (byte_offset, _) in text.char_indices() {
        index[byte_offset] = chars;
        chars += 1;
    }
    // Interior bytes of a multi-byte character are never addressed by Lindera,
    // but filling them keeps the lookup total rather than panicking if they are.
    let mut last = 0;
    for slot in index.iter_mut() {
        if *slot == 0 && last != 0 {
            *slot = last;
        } else {
            last = *slot;
        }
    }
    index[text.len()] = chars;
    index
}

/// Whether a character carries meaning worth looking up. Bare punctuation and
/// standalone digits do not.
fn is_worth_clicking(ch: char) -> bool {
    ch.is_alphabetic() || crate::language::is_japanese_char(ch)
}

/// Converts a katakana reading to hiragana.
///
/// IPADIC stores every reading in katakana, but learners read furigana in
/// hiragana — showing カタカナ over a kanji is technically correct and
/// practically wrong.
pub fn katakana_to_hiragana(input: &str) -> String {
    input
        .chars()
        .map(|ch| match ch {
            // The two syllabaries are laid out identically 0x60 apart. ヷ-ヺ
            // (0x30F7..=0x30FA) have no hiragana equivalent and are excluded.
            '\u{30A1}'..='\u{30F6}' => char::from_u32(ch as u32 - 0x60).unwrap_or(ch),
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_katakana_readings_to_hiragana() {
        assert_eq!(katakana_to_hiragana("タベル"), "たべる");
        assert_eq!(katakana_to_hiragana("ニホンゴ"), "にほんご");
        // Prolonged sound marks and ASCII pass through untouched.
        assert_eq!(katakana_to_hiragana("コーヒー"), "こーひー");
        assert_eq!(katakana_to_hiragana("OK"), "OK");
    }

    #[test]
    fn maps_byte_offsets_to_char_offsets() {
        // Every character here is three bytes in UTF-8.
        let index = byte_to_char_index("日本語");
        assert_eq!(index[0], 0);
        assert_eq!(index[3], 1);
        assert_eq!(index[6], 2);
        assert_eq!(index[9], 3);
    }

    #[test]
    fn char_offsets_slice_the_original_text() {
        let Some(segmenter) = segmenter() else {
            return; // dictionary unavailable in this environment
        };
        let text = "今日はいい天気ですね";
        let tokens = tokenize(segmenter, text);
        assert!(!tokens.is_empty());

        let chars: Vec<char> = text.chars().collect();
        for token in &tokens {
            let sliced: String = chars[token.start..token.end].iter().collect();
            assert_eq!(sliced, token.surface, "offsets must round-trip");
        }
    }

    #[test]
    fn recovers_dictionary_forms_for_inflected_verbs() {
        let Some(segmenter) = segmenter() else {
            return;
        };
        let tokens = tokenize(segmenter, "食べた");
        let verb = tokens
            .iter()
            .find(|t| t.pos == PartOfSpeech::Verb)
            .expect("食べ should be tagged as a verb");
        assert_eq!(verb.base, "食べる");
        assert_eq!(verb.reading, "たべ");
    }

    #[test]
    fn punctuation_is_not_clickable() {
        let Some(segmenter) = segmenter() else {
            return;
        };
        let tokens = tokenize(segmenter, "はい、そうです。");
        assert!(tokens.iter().any(|t| t.clickable));
        assert!(tokens.iter().filter(|t| t.surface == "。").all(|t| !t.clickable));
    }
}

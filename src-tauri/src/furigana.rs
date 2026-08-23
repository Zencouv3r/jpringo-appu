//! Pairing a word with its reading, one kanji group at a time.
//!
//! Two callers want the same alignment for different reasons. The Anki export
//! wants it written out as ruby (`食[た]べる`); the kanji screen wants the
//! pieces themselves, because a group that is exactly one character long is
//! evidence of how that character is read — the only evidence the app has,
//! since nothing here ships a per-character reading dictionary.
//!
//! Kanji are never split without that evidence. 気持ち aligns as one group,
//! `気持` + きも, rather than guessing which of the two owns which mora, and a
//! reading that cannot be aligned at all yields nothing rather than something
//! plausible. A wrong reading is worse than a missing one: it is the kind of
//! error a learner memorises.

use crate::analyze::tokenize::katakana_to_hiragana;
use crate::language;

/// One piece of a word, with the part of the reading it accounts for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ruby {
    /// Kana (or latin, or a digit) — it reads as itself.
    Plain(String),
    /// A run of kanji, and the reading aligned to it.
    Base { text: String, reading: String },
}

/// Splits a word against its reading, kana runs anchoring the kanji groups.
///
/// `None` when the two disagree — a reading that does not contain the word's
/// own kana is not a reading of that word.
pub fn pieces(word: &str, reading: &str) -> Option<Vec<Ruby>> {
    let reading = reading.trim();
    if reading.is_empty() {
        return None;
    }

    // Both sides are compared in hiragana so that a katakana word (消しゴム)
    // still matches a hiragana reading (けしごむ). The conversion is
    // character-for-character, so the vectors stay index-aligned with the
    // originals.
    let word_chars: Vec<char> = word.chars().collect();
    let word_kana: Vec<char> = katakana_to_hiragana(word).chars().collect();
    let reading_kana: Vec<char> = katakana_to_hiragana(reading).chars().collect();

    align(&word_chars, &word_kana, &reading_kana)
}

/// Writes a word and its reading in Anki's furigana notation.
///
/// `食べる` + `たべる` becomes `食[た]べる`, which Anki's Japanese Support
/// add-on renders as ruby text above the kanji and — more usefully — leaves
/// alone everywhere else, so the field is still readable on a note type that
/// knows nothing about Japanese.
///
/// The notation is positional: the ruby applies to the run of characters back
/// to the previous space, which is why a kanji group following kana gets a
/// space in front of it (`お 客[きゃく]さん`). Getting that wrong would put
/// きゃく over お客.
///
/// When the reading cannot be aligned at all, the whole word gets one bracket,
/// which is still correct ruby.
pub fn write(word: &str, reading: &str) -> String {
    let reading = reading.trim();
    if reading.is_empty() || word == reading {
        return word.to_string();
    }

    // Nothing to annotate: a word written entirely in kana already reads the
    // way it looks, and bracketing it would only add clutter.
    if !word.chars().any(is_ruby_base) {
        return word.to_string();
    }

    let reading_kana = katakana_to_hiragana(reading);
    pieces(word, reading)
        .map(|pieces| render(&pieces))
        .unwrap_or_else(|| format!("{word}[{reading_kana}]"))
}

/// Joins aligned pieces back into the positional notation.
fn render(pieces: &[Ruby]) -> String {
    let mut out = String::new();
    for piece in pieces {
        match piece {
            Ruby::Plain(text) => out.push_str(text),
            Ruby::Base { text, reading } => {
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(text);
                out.push('[');
                out.push_str(reading);
                out.push(']');
            }
        }
    }
    out
}

/// Characters that take ruby above them.
///
/// The iteration mark 々 and the abbreviations 〆 and ヶ belong to the group
/// they follow rather than being read on their own — 時々 is ときどき, not
/// とき plus something. Treating them as kanji keeps such words in one piece.
fn is_ruby_base(ch: char) -> bool {
    language::is_han(ch) || matches!(ch, '々' | '〆' | 'ヶ')
}

/// Walks the word and the reading together, kana runs anchoring the kanji.
///
/// Returns `None` the moment the two disagree, rather than emitting
/// confident-looking ruby from a reading that never belonged to this word.
fn align(word: &[char], word_kana: &[char], reading: &[char]) -> Option<Vec<Ruby>> {
    let mut pieces = Vec::new();
    let mut index = 0usize;
    let mut pos = 0usize;

    while index < word.len() {
        if is_ruby_base(word[index]) {
            let start = index;
            while index < word.len() && is_ruby_base(word[index]) {
                index += 1;
            }

            // The kana immediately after this group is what tells us where its
            // reading ends. With nothing after it, the rest of the reading is
            // the group's.
            let anchor_end = word[index..]
                .iter()
                .position(|ch| is_ruby_base(*ch))
                .map_or(word.len(), |offset| index + offset);
            let ruby_end = if index == anchor_end {
                reading.len()
            } else {
                // From `pos + 1`: the group must be worth at least one mora,
                // or the anchor would be matching kana that belongs to it.
                find_from(reading, &word_kana[index..anchor_end], pos + 1)?
            };
            if ruby_end <= pos {
                return None;
            }

            pieces.push(Ruby::Base {
                text: word[start..index].iter().collect(),
                reading: reading[pos..ruby_end].iter().collect(),
            });
            pos = ruby_end;
        } else {
            // Kana (or latin, or a digit) the reading has to contain verbatim.
            let start = index;
            while index < word.len() && !is_ruby_base(word[index]) {
                if pos >= reading.len() || reading[pos] != word_kana[index] {
                    return None;
                }
                index += 1;
                pos += 1;
            }
            pieces.push(Ruby::Plain(word[start..index].iter().collect()));
        }
    }

    // Reading left over means the word did not account for all of it.
    (pos == reading.len()).then_some(pieces)
}

/// First index at or after `from` where `needle` starts.
fn find_from(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len().saturating_sub(needle.len()))
        .find(|start| &haystack[*start..*start + needle.len()] == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn okurigana_keeps_its_kana_outside_the_brackets() {
        assert_eq!(write("食べる", "たべる"), "食[た]べる");
        assert_eq!(write("話す", "はなす"), "話[はな]す");
    }

    /// Anki's notation is positional — without the space, きゃく would be read
    /// as the ruby for お客 rather than for 客 alone.
    #[test]
    fn a_kanji_group_after_kana_is_separated_by_a_space() {
        assert_eq!(write("お客さん", "おきゃくさん"), "お 客[きゃく]さん");
    }

    #[test]
    fn interleaved_kana_splits_the_word_into_groups() {
        assert_eq!(write("食べ物", "たべもの"), "食[た]べ 物[もの]");
        assert_eq!(write("引っ越し", "ひっこし"), "引[ひ]っ 越[こ]し");
    }

    /// Splitting 日本語 into 日[に] 本[ほん] 語[ご] needs a per-character
    /// reading dictionary the app does not have, and guessing is how furigana
    /// ends up wrong.
    #[test]
    fn adjacent_kanji_share_one_reading() {
        assert_eq!(write("日本語", "にほんご"), "日本語[にほんご]");
    }

    #[test]
    fn kana_only_words_are_left_alone() {
        assert_eq!(write("ねこ", "ねこ"), "ねこ");
        assert_eq!(write("コーヒー", "こーひー"), "コーヒー");
    }

    #[test]
    fn katakana_in_the_word_matches_a_hiragana_reading() {
        assert_eq!(write("消しゴム", "けしゴム"), "消[け]しゴム");
    }

    #[test]
    fn the_iteration_mark_stays_with_its_kanji() {
        assert_eq!(write("時々", "ときどき"), "時々[ときどき]");
    }

    #[test]
    fn an_unalignable_reading_falls_back_to_one_bracket() {
        assert_eq!(write("食べる", "むちゃくちゃ"), "食べる[むちゃくちゃ]");
    }

    #[test]
    fn a_missing_reading_leaves_the_word_bare() {
        assert_eq!(write("食べる", ""), "食べる");
    }

    /// What the kanji screen reads: a group of exactly one character is that
    /// character's reading, and nothing else in the log says so.
    #[test]
    fn a_lone_kanji_group_attributes_its_reading() {
        let pieces = pieces("食べる", "たべる").expect("alignable");
        assert_eq!(
            pieces,
            vec![
                Ruby::Base { text: "食".into(), reading: "た".into() },
                Ruby::Plain("べる".into()),
            ]
        );
    }

    #[test]
    fn a_group_of_two_attributes_nothing_to_either() {
        let pieces = pieces("日本語", "にほんご").expect("alignable");
        assert_eq!(
            pieces,
            vec![Ruby::Base { text: "日本語".into(), reading: "にほんご".into() }]
        );
    }

    #[test]
    fn a_reading_that_is_not_this_word_aligns_to_nothing() {
        assert_eq!(pieces("食べる", "むちゃくちゃ"), None);
    }
}

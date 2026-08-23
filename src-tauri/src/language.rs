//! Deciding what language a subtitle track is actually written in.
//!
//! Container language tags are unreliable — they are missing on a lot of
//! releases and wrong on plenty more — and the cost of trusting a wrong one is
//! high: a mislabelled track gets transcribed, tokenized, and then paid for by
//! the word at the OpenAI endpoint before anyone notices it was Chinese.
//!
//! The decisive signal is **kana**. Japanese cannot be written without
//! hiragana or katakana; Chinese uses none at all. Any check that treats CJK
//! ideographs as "Japanese" accepts Chinese subtitles outright, which is
//! exactly the mistake this module exists to prevent.

use serde::{Deserialize, Serialize};

/// Minimum number of scriptful characters before a verdict means anything.
/// A three-line forced track is not enough text to classify.
const MIN_SAMPLE: usize = 20;

/// Japanese needs *some* kana. Even the most kanji-dense prose carries
/// particles; 5% is far below real Japanese (usually 40-60%) and far above
/// Chinese (0%), so it separates the two without being fussy.
const MIN_KANA_RATIO: f64 = 0.05;

/// Combined kana + kanji share required to call a track Japanese, so a
/// mostly-English track with a few Japanese signs doesn't qualify.
const MIN_JAPANESE_RATIO: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Script {
    Japanese,
    /// Han characters with no kana — Chinese, and the case most likely to be
    /// mistaken for Japanese.
    Chinese,
    Korean,
    /// English and other Latin-script languages.
    Latin,
    Cyrillic,
    /// Some other script, or too little text to judge.
    Unknown,
}

impl Script {
    pub fn label(self) -> &'static str {
        match self {
            Self::Japanese => "Japanese",
            Self::Chinese => "Chinese",
            Self::Korean => "Korean",
            Self::Latin => "Latin script",
            Self::Cyrillic => "Cyrillic",
            Self::Unknown => "unrecognized",
        }
    }

    /// A language-ish code for the transcript.
    ///
    /// Only the CJK three are real ISO 639 codes; a Latin- or Cyrillic-script
    /// track could be any of dozens of languages and this deliberately does not
    /// guess which. It is a fallback for when the container carried no language
    /// tag at all, never a claim about the language itself.
    pub fn code(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::Chinese => "zh",
            Self::Korean => "ko",
            Self::Latin => "latn",
            Self::Cyrillic => "cyrl",
            Self::Unknown => "und",
        }
    }
}

/// The result of inspecting a body of text.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub script: Script,
    /// Share of scriptful characters that are hiragana or katakana.
    pub kana_ratio: f64,
    /// Share that are CJK ideographs.
    pub han_ratio: f64,
    /// How strongly the text matches [`Script::Japanese`], 0.0 to 1.0.
    pub japanese_confidence: f64,
    /// Characters actually counted, after punctuation and digits were skipped.
    pub sample_size: usize,
}

impl Detection {
    pub fn is_japanese(&self) -> bool {
        self.script == Script::Japanese
    }
}

#[derive(Default)]
struct Counts {
    kana: usize,
    han: usize,
    hangul: usize,
    latin: usize,
    cyrillic: usize,
    total: usize,
}

pub fn is_hiragana(ch: char) -> bool {
    ('\u{3040}'..='\u{309F}').contains(&ch)
}

pub fn is_katakana(ch: char) -> bool {
    ('\u{30A0}'..='\u{30FF}').contains(&ch) || ('\u{FF66}'..='\u{FF9D}').contains(&ch)
}

pub fn is_kana(ch: char) -> bool {
    is_hiragana(ch) || is_katakana(ch)
}

/// CJK ideographs — shared by Japanese and Chinese, so never decisive alone.
pub fn is_han(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
        || ('\u{3400}'..='\u{4DBF}').contains(&ch)
        || ('\u{F900}'..='\u{FAFF}').contains(&ch)
}

/// Any character that carries Japanese meaning. Used to decide whether a token
/// is worth making clickable.
pub fn is_japanese_char(ch: char) -> bool {
    is_kana(ch) || is_han(ch)
}

fn is_hangul(ch: char) -> bool {
    ('\u{AC00}'..='\u{D7AF}').contains(&ch)
        || ('\u{1100}'..='\u{11FF}').contains(&ch)
        || ('\u{3130}'..='\u{318F}').contains(&ch)
}

fn is_cyrillic(ch: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&ch)
}

fn count(text: &str) -> Counts {
    let mut counts = Counts::default();
    for ch in text.chars() {
        // Punctuation, digits, and whitespace are script-neutral — a line of
        // "!?!?" says nothing about the language and would only dilute ratios.
        if ch.is_whitespace() || ch.is_numeric() || is_neutral_punctuation(ch) {
            continue;
        }

        if is_kana(ch) {
            counts.kana += 1;
        } else if is_han(ch) {
            counts.han += 1;
        } else if is_hangul(ch) {
            counts.hangul += 1;
        } else if is_cyrillic(ch) {
            counts.cyrillic += 1;
        } else if ch.is_alphabetic() {
            counts.latin += 1;
        } else {
            // Symbols and anything unclassified: skip rather than count, so
            // they can't tip a ratio.
            continue;
        }
        counts.total += 1;
    }
    counts
}

fn is_neutral_punctuation(ch: char) -> bool {
    ch.is_ascii_punctuation()
        // CJK punctuation, full-width forms, and the prolonged sound mark's
        // neighbours. Note U+30FC (ー) is inside the katakana block and is
        // deliberately counted as kana, since only Japanese uses it that way.
        || ('\u{3000}'..='\u{303F}').contains(&ch)
        || ('\u{FF01}'..='\u{FF20}').contains(&ch)
        || matches!(ch, '♪' | '♫' | '…' | '—' | '–')
}

/// Classifies a collection of lines.
///
/// Judged together rather than line by line: single lines are often too short
/// to classify, and one interjection should not outweigh a whole track.
pub fn detect_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Detection {
    let sample: Vec<&str> = lines.collect();
    detect(&sample.join("\n"))
}

/// Classifies a body of text.
pub fn detect(text: &str) -> Detection {
    let counts = count(text);

    if counts.total < MIN_SAMPLE {
        return Detection {
            script: Script::Unknown,
            kana_ratio: 0.0,
            han_ratio: 0.0,
            japanese_confidence: 0.0,
            sample_size: counts.total,
        };
    }

    let total = counts.total as f64;
    let kana_ratio = counts.kana as f64 / total;
    let han_ratio = counts.han as f64 / total;
    let hangul_ratio = counts.hangul as f64 / total;
    let latin_ratio = counts.latin as f64 / total;
    let cyrillic_ratio = counts.cyrillic as f64 / total;
    let japanese_ratio = kana_ratio + han_ratio;

    let script = if kana_ratio >= MIN_KANA_RATIO && japanese_ratio >= MIN_JAPANESE_RATIO {
        Script::Japanese
    } else if han_ratio >= MIN_JAPANESE_RATIO && kana_ratio < 0.02 {
        // Han-heavy with effectively no kana. This branch is the whole point
        // of the module.
        Script::Chinese
    } else if hangul_ratio >= 0.3 {
        Script::Korean
    } else if cyrillic_ratio >= 0.5 {
        Script::Cyrillic
    } else if latin_ratio >= 0.6 {
        Script::Latin
    } else {
        Script::Unknown
    };

    // Confidence is driven by kana presence, because that is what actually
    // distinguishes Japanese. Saturates around 30% kana, which ordinary
    // Japanese prose clears easily.
    let japanese_confidence = if script == Script::Japanese {
        ((kana_ratio / 0.3).min(1.0) * 0.7 + japanese_ratio.min(1.0) * 0.3).min(1.0)
    } else {
        (kana_ratio / 0.3).min(1.0) * japanese_ratio
    };

    Detection {
        script,
        kana_ratio,
        han_ratio,
        japanese_confidence,
        sample_size: counts.total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_ordinary_japanese() {
        let text = "おはようございます、今日はいい天気ですね。昨日は友達と一緒に映画を見に行きました。";
        let d = detect(text);
        assert_eq!(d.script, Script::Japanese);
        assert!(d.japanese_confidence > 0.8, "confidence was {}", d.japanese_confidence);
    }

    #[test]
    fn rejects_chinese_that_looks_japanese_to_a_naive_check() {
        // Every character here is a CJK ideograph, so a han-only check would
        // happily accept this as Japanese and bill it to the API.
        let text = "早上好今天天气很好我昨天和朋友一起去看电影了非常有趣我们明天再见吧";
        let d = detect(text);
        assert_eq!(d.script, Script::Chinese);
        assert!(!d.is_japanese());
        assert_eq!(d.kana_ratio, 0.0);
    }

    #[test]
    fn rejects_english() {
        let text = "Good morning, the weather is nice today. Yesterday I went to see a movie.";
        let d = detect(text);
        assert_eq!(d.script, Script::Latin);
        assert!(!d.is_japanese());
    }

    #[test]
    fn rejects_korean() {
        let text = "안녕하세요 오늘 날씨가 좋네요 어제 친구와 함께 영화를 보러 갔습니다 정말 재미있었어요";
        let d = detect(text);
        assert_eq!(d.script, Script::Korean);
        assert!(!d.is_japanese());
    }

    #[test]
    fn rejects_russian() {
        let text = "Доброе утро сегодня хорошая погода вчера я ходил с другом в кино было очень весело";
        let d = detect(text);
        assert_eq!(d.script, Script::Cyrillic);
        assert!(!d.is_japanese());
    }

    #[test]
    fn accepts_kanji_heavy_japanese_with_few_particles() {
        // Dense written Japanese still carries kana; this must not be mistaken
        // for Chinese.
        let text = "本日開催予定の全国高等学校野球選手権大会は雨天のため中止となりました。";
        let d = detect(text);
        assert_eq!(d.script, Script::Japanese);
    }

    #[test]
    fn a_handful_of_japanese_signs_in_an_english_track_is_not_japanese() {
        let text = "Tokyo Station. The train departs at nine. Please stand behind the line. 東京駅";
        assert_ne!(detect(text).script, Script::Japanese);
    }

    #[test]
    fn too_little_text_is_unknown_rather_than_guessed() {
        let d = detect("東京");
        assert_eq!(d.script, Script::Unknown);
        assert!(d.sample_size < MIN_SAMPLE);
    }

    #[test]
    fn punctuation_and_digits_do_not_dilute_the_verdict() {
        let plain = detect("おはようございます、今日はいい天気ですね。");
        let noisy = detect("おはようございます、今日はいい天気ですね。 123 !?!? 456 ...");
        assert_eq!(plain.script, noisy.script);
        assert!((plain.kana_ratio - noisy.kana_ratio).abs() < 0.05);
    }

    #[test]
    fn katakana_only_text_is_still_japanese() {
        let text = "コンピューターゲームセンターマシンサーバーネットワークデータベース";
        assert_eq!(detect(text).script, Script::Japanese);
    }
}

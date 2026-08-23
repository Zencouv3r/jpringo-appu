# Ringo
**A desktop app for studying Japanese from video**.
**Powered by Rust+Tauri and next.js**
Transcribe the anime episode with whisper model, or use embedded subtitles, generate translations and explanations of words/kanjis with AI.

Also the translation and all that stuff is provided by AI, so u will need an API key for that.

Every word you meet is logged. The dictionary screen is a record of the vocabulary of the shows you actually watch: how often each word has come up, in which episodes, what it can mean, and the lines you met it in.
Also Anki export of words provided. 
## feautures
- Generate subtitles automatically with whisper model
- Generate explanations that count context for words
- Save all words you have met in the dictionary including their meaning
- Export words as ANKI deck
- See what words the most frequently used in series you watch.
- Support every that ffmpeg could read.
- Words caching, means the more episodes you watch - the less will be spendings on translations
- TODO: Impelement OCR to recognize and translate stuff on the screen
- TODO: Mac and Linux support(currently only windows works)
## how it works
```

video file

   │
   ├─ ffprobe ─────────► container, codecs, subtitle tracks
   ├─ TRANSCRIPT — local, free, automatic where it can be
   │    ├─ embedded subtitle track    ← read on open; any language displays
   │    ├─ sibling .srt/.ass/.vtt file
   │    └─ ffmpeg → 16kHz mono WAV → whisper.cpp   ← only when asked for
   │
   ├─ Lindera (IPADIC) ─► every word segmented, with reading + dictionary form
   │                       │
   │                       └──────────────┐
   ├─ EXPLANATIONS 
   │    ├─ OpenAI ─► senses for words not already known ──► vocabulary.json
   │    └─ OpenAI ─► per-line translation + in-context     ◄──┘ (senses reused)
   │                 meaning and grammar for each word
   │
   └─ cached as JSON, keyed by a content hash of the video
```

Also the gpt-5-mini with minimal reasoing is enough to get proper explanations for most encountered words. Prefer to use this bc higher reasoning takes a lot of time and spend a lot of tokens tho.
## usage
Set up the API key in settings, pick the video in supported format and drop it to the app or simply choose it.
If there's no subtitles - you can generate them with whisper model. Then generate the explanations and meanings for words, and watch series with full translation and explanation for every word u  met!

## limits
- **Furigana is aligned, not looked up.** The kana in a word anchor the reading around it, so 食べる and 引っ越し split correctly, but two adjacent kanji share one bracket (`日本語[にほんご]`).

- **Kanji readings are evidence, not a dictionary.** The same alignment is whatthe kanji panel lists readings from, so a character only gets one where someword you have met pins it down - 食べる saying that 食 is た.

## build(windows only)
Requires Node and rust toolchain(1.82 or newer), plus the MSVC C++ build tools and the WebView2 runtime on Windows.
```bash

npm install

pwsh -File scripts/fetch-sidecars.ps1    # ffmpeg, ffprobe, whisper-cli

```
### Anki export
Exports as tab-separated text rather than an `.apkg` - word, reading, meaning, example, example translation, and optional `ringo::`-prefixed tags - so the columns map onto whatever note type you already study with. Readings can carry furigana (`食[た]べる`), and rows are ordered most-frequent-first, which is the order Anki introduces new cards in.
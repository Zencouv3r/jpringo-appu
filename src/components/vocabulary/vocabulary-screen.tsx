"use client";

import { useState } from "react";
import {
  ArrowLeft,
  BookMarked,
  Download,
  Languages,
  Library,
  Loader2,
  Search,
  X,
} from "lucide-react";

import { AnkiExportDialog } from "@/components/vocabulary/anki-export-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useKanjiDetail, useVocabulary } from "@/hooks/use-vocabulary";
import { VOCAB_PAGE_SIZE } from "@/lib/types";
import type { JlptLevel, KanjiStat, VocabEntry, VocabSort } from "@/lib/types";
import { JLPT_CLASS, cn, formatCount, formatTimestamp } from "@/lib/utils";

const SORT_OPTIONS: { value: VocabSort; label: string }[] = [
  { value: "frequency", label: "Most seen" },
  { value: "recent", label: "Recent" },
  { value: "jlpt", label: "JLPT level" },
  { value: "alphabetical", label: "A-Z (by reading)" },
];

const JLPT_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Any level" },
  { value: "N5", label: "N5" },
  { value: "N4", label: "N4" },
  { value: "N3", label: "N3" },
  { value: "N2", label: "N2" },
  { value: "N1", label: "N1" },
  { value: "none", label: "Unlevelled" },
];

/**
 * Sentinels for the unfiltered case. Base UI's Select has no null value, so
 * "no filter" has to be a string no real series or episode could be called.
 */
const ALL_SERIES = "__everything__";
const ALL_EPISODES = "__every-episode__";

interface VocabularyScreenProps {
  /** A word to open on, from the "Open in dictionary" button in the player. */
  initialLemma?: string | null;
  onClose: () => void;
}

/**
 * Every word the user has met, in one place.
 *
 * Built from the transcripts they have actually watched rather than a
 * pre-baked frequency list, which is the difference between "words that are
 * common in Japanese" and "words this show keeps using". Counts, senses, and
 * real example lines all come from the vocabulary store.
 */
export function VocabularyScreen({ initialLemma, onClose }: VocabularyScreenProps) {
  // Arriving from a clicked word opens straight onto it, as the initial search
  // rather than as a patch applied after the first query has already run.
  const { query, update, page, sources, kanji, isLoading } = useVocabulary(
    initialLemma ?? "",
  );
  const [selectedLemma, setSelectedLemma] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  // Controlled, because the kanji panel sends the reader to a word: picking
  // one there has to move the screen to the tab that can show it.
  const [tab, setTab] = useState("words");
  const [pickedKanji, setPickedKanji] = useState<string | null>(null);

  const entries = page?.entries ?? [];
  // What the query asked for, which is what the pager has to step by — see
  // the buttons below.
  const pageSize = query.limit || VOCAB_PAGE_SIZE;
  // Episodes of the series currently filtered to, for the second filter.
  const episodes = query.series
    ? (sources.find((source) => source.series === query.series)?.videos ?? [])
    : [];
  // Derived rather than synced: after a filter change the previously selected
  // word may not be in the list any more, and falling back to the first row is
  // the right answer in every such case.
  const selected =
    entries.find((entry) => entry.lemma === selectedLemma) ?? entries[0] ?? null;
  // Same rule for the kanji grid: the panel opens on the most frequent
  // character rather than on an explanation of how to fill it.
  const selectedKanji = pickedKanji ?? kanji[0]?.character ?? null;

  /** Sends the reader from a kanji to one of the words that uses it. */
  const openWord = (lemma: string) => {
    update({ search: lemma });
    setSelectedLemma(lemma);
    setTab("words");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onClose}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <BookMarked className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Dictionary</h1>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {page && (
            <span className="text-xs text-muted-foreground">
              {formatCount(page.totalWords)} words ·{" "}
              {formatCount(page.totalEncounters)} encounters
              {page.undefined > 0 && ` · ${formatCount(page.undefined)} not looked up yet`}
            </span>
          )}
          {/* Sits in the header rather than beside the filters: it exports the
              whole log under its own options, not whatever the list is
              currently showing. */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!page || page.totalWords === 0}
            onClick={() => setIsExporting(true)}
          >
            <Download className="size-3.5" />
            Export to Anki
          </Button>
        </div>
      </header>

      <AnkiExportDialog
        open={isExporting}
        onOpenChange={setIsExporting}
        sources={sources}
        initialSeries={query.series}
      />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <TabsList>
            <TabsTrigger value="words">
              <Library className="size-3.5" />
              Words
            </TabsTrigger>
            <TabsTrigger value="kanji">
              <Languages className="size-3.5" />
              Kanji
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="words" className="flex min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                onChange={(event) => update({ search: event.target.value })}
                placeholder="Search a word, reading, or meaning…"
                className="h-8 pr-8 pl-8 text-sm"
              />
              {query.search && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
                  aria-label="Clear search"
                  onClick={() => update({ search: "" })}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>

            <Select
              value={query.sort}
              onValueChange={(value) => update({ sort: value as VocabSort })}
            >
              <SelectTrigger size="sm" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={query.jlpt ?? "all"}
              onValueChange={(value) =>
                update({ jlpt: value === "all" ? null : (value as JlptLevel) })
              }
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JLPT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {sources.length > 0 && (
              <Select
                value={query.series ?? ALL_SERIES}
                onValueChange={(value) =>
                  update({
                    series: value === ALL_SERIES ? null : value,
                    // Series and video are two views of the same filter; a new
                    // series must not keep an episode from the old one.
                    videoId: null,
                  })
                }
              >
                <SelectTrigger size="sm" className="max-w-56 min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SERIES}>Everything watched</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source.series} value={source.series}>
                      {source.series} ({formatCount(source.wordCount)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Only once a series is picked, and only when it has more than one
                episode — a one-episode series would offer a choice of one. */}
            {episodes.length > 1 && (
              <Select
                value={query.videoId ?? ALL_EPISODES}
                onValueChange={(value) =>
                  update({ videoId: value === ALL_EPISODES ? null : value })
                }
              >
                <SelectTrigger size="sm" className="max-w-56 min-w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_EPISODES}>Every episode</SelectItem>
                  {episodes.map((episode) => (
                    <SelectItem key={episode.videoId} value={episode.videoId}>
                      {episode.title} ({formatCount(episode.wordCount)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {isLoading && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {entries.length === 0 && !isLoading ? (
                <EmptyLog hasFilter={Boolean(query.search || query.series || query.jlpt)} />
              ) : (
                <ul className="divide-y divide-border/60">
                  {entries.map((entry) => (
                    <li key={entry.lemma}>
                      <WordRow
                        entry={entry}
                        isSelected={selected?.lemma === entry.lemma}
                        onSelect={() => setSelectedLemma(entry.lemma)}
                      />
                    </li>
                  ))}
                </ul>
              )}

              {page && page.total > entries.length && (
                <div className="flex items-center justify-between gap-2 p-3 text-xs text-muted-foreground">
                  <span>
                    {query.offset + 1}–{query.offset + entries.length} of{" "}
                    {formatCount(page.total)}
                  </span>
                  <div className="flex gap-1.5">
                    {/* Stepped by the page size, not by the number of rows
                        that came back. The last page is short, so subtracting
                        `entries.length` from it lands between pages: with 250
                        words, Previous from row 201 went to 151 and the pages
                        after it could never be reached again. */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={query.offset === 0}
                      onClick={() =>
                        update({ offset: Math.max(0, query.offset - pageSize) })
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={query.offset + entries.length >= page.total}
                      onClick={() => update({ offset: query.offset + pageSize })}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <aside className="hidden w-[24rem] shrink-0 overflow-y-auto border-l border-border lg:block">
              <WordDetail entry={selected} />
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="kanji" className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <KanjiGrid stats={kanji} selected={selectedKanji} onPick={setPickedKanji} />
          </div>

          {/* Kept down at `md` rather than `lg` like the word list's panel:
              the window can be dragged to 960px, and a card that opens
              nothing is the complaint this panel exists to answer. */}
          <aside className="hidden w-[24rem] shrink-0 overflow-y-auto border-l border-border md:block">
            <KanjiDetail
              character={selectedKanji}
              onOpenWord={openWord}
              onSearchWords={(character) => {
                update({ search: character });
                setSelectedLemma(null);
                setTab("words");
              }}
            />
          </aside>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WordRow({
  entry,
  isSelected,
  onSelect,
}: {
  entry: VocabEntry;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors",
        isSelected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
    >
      <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {formatCount(entry.count)}×
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[15px] font-medium">{entry.lemma}</span>
          {entry.reading && entry.reading !== entry.lemma && (
            <span className="text-xs text-muted-foreground">{entry.reading}</span>
          )}
          {entry.jlptLevel !== "none" && (
            <Badge className={cn("text-[10px]", JLPT_CLASS[entry.jlptLevel])}>
              {entry.jlptLevel}
            </Badge>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {entry.senses.length > 0
            ? entry.senses.join("; ")
            : "Not looked up yet — run the explanations on a video with this word."}
        </span>
      </span>
    </button>
  );
}

/** Everything known about one word: senses, where it came from, real lines. */
function WordDetail({ entry }: { entry: VocabEntry | null }) {
  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BookMarked className="size-5 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">
          Pick a word to see its meanings and where you met it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-2xl leading-tight font-medium">{entry.lemma}</span>
          {entry.reading && entry.reading !== entry.lemma && (
            <span className="text-sm text-muted-foreground">{entry.reading}</span>
          )}
          {entry.jlptLevel !== "none" && (
            <Badge className={cn("text-[10px]", JLPT_CLASS[entry.jlptLevel])}>
              {entry.jlptLevel}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {entry.partOfSpeech && <span>{entry.partOfSpeech} · </span>}
          seen {formatCount(entry.count)}× across {entry.sources.length}{" "}
          {entry.sources.length === 1 ? "video" : "videos"}
        </p>
      </header>

      {entry.senses.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Meanings
          </h3>
          <ol className="space-y-0.5">
            {entry.senses.map((sense, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed">
                {entry.senses.length > 1 && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                )}
                <span>{sense}</span>
              </li>
            ))}
          </ol>
          {entry.note && (
            <p className="text-xs leading-relaxed text-muted-foreground">{entry.note}</p>
          )}
        </section>
      )}

      {entry.examples.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Where you met it
            </h3>
            {entry.examples.map((example, index) => (
              <div key={index} className="space-y-0.5 border-l-2 border-border pl-2.5">
                <p className="text-sm leading-relaxed">{example.text}</p>
                {example.translation && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {example.translation}
                  </p>
                )}
                {example.meaning && (
                  <p className="text-xs leading-relaxed">
                    <span className="text-muted-foreground">Here: </span>
                    {example.meaning}
                    {example.grammar && ` — ${example.grammar}`}
                  </p>
                )}
                <p className="truncate text-[11px] text-muted-foreground/80">
                  {example.title} · {formatTimestamp(example.start)}
                </p>
              </div>
            ))}
          </section>
        </>
      )}

      <Separator />

      <section className="space-y-1">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Frequency
        </h3>
        <ul className="space-y-1">
          {[...entry.sources]
            .sort((a, b) => b.count - a.count)
            .map((source) => (
              <li
                key={source.videoId}
                className="flex items-baseline gap-2 text-xs text-muted-foreground"
              >
                <span className="w-8 shrink-0 text-right tabular-nums">
                  {formatCount(source.count)}×
                </span>
                <span className="min-w-0 flex-1 truncate">{source.title}</span>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function KanjiGrid({
  stats,
  selected,
  onPick,
}: {
  stats: KanjiStat[];
  selected: string | null;
  onPick: (character: string) => void;
}) {
  if (stats.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
        <Languages className="size-5" />
        <p>No kanji yet. Generate a transcript for a video to start the log.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 p-3">
      {stats.map((stat) => (
        <button
          key={stat.character}
          type="button"
          onClick={() => onPick(stat.character)}
          aria-pressed={selected === stat.character}
          className={cn(
            "flex flex-col items-center gap-1 rounded-[1.5px] border p-3 text-center transition-colors",
            selected === stat.character
              ? "border-primary/60 bg-accent/60"
              : "border-border hover:border-primary/50 hover:bg-accent/40",
          )}
          title={stat.words.join("、")}
        >
          <span className="text-2xl leading-none">{stat.character}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatCount(stat.count)}× · {formatCount(stat.wordCount)} words
          </span>
          <span className="line-clamp-1 text-[11px] text-muted-foreground/80">
            {stat.words.slice(0, 3).join("、")}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * One kanji, as the log knows it.
 *
 * Everything here is read off the words the user has actually met: the
 * readings are aligned out of them, a meaning appears only where the character
 * has been met as a word by itself, and the examples are those words. There is
 * no character dictionary behind this, and the panel never pretends there is —
 * a section with nothing in it says what would put something there.
 */
function KanjiDetail({
  character,
  onOpenWord,
  onSearchWords,
}: {
  character: string | null;
  onOpenWord: (lemma: string) => void;
  onSearchWords: (character: string) => void;
}) {
  const { detail, isLoading } = useKanjiDetail(character);

  if (!character) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Languages className="size-5 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">
          Pick a character to see how it is read and where you met it.
        </p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            Nothing logged for {character} yet.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-4xl leading-none font-medium">{detail.character}</span>
          {detail.reading && (
            <span className="text-sm text-muted-foreground">{detail.reading}</span>
          )}
          {detail.jlptLevel !== "none" && (
            <Badge className={cn("text-[10px]", JLPT_CLASS[detail.jlptLevel])}>
              {detail.jlptLevel}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          read {formatCount(detail.count)}× across {formatCount(detail.wordCount)}{" "}
          {detail.wordCount === 1 ? "word" : "words"}
        </p>
      </header>

      {detail.senses.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            As a word on its own
          </h3>
          <ol className="space-y-0.5">
            {detail.senses.map((sense, index) => (
              <li key={index} className="flex gap-2 text-sm leading-relaxed">
                {detail.senses.length > 1 && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                )}
                <span>{sense}</span>
              </li>
            ))}
          </ol>
          {detail.note && (
            <p className="text-xs leading-relaxed text-muted-foreground">{detail.note}</p>
          )}
        </section>
      )}

      <Separator />

      <section className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Readings
        </h3>
        {detail.readings.length > 0 ? (
          <ul className="space-y-1.5">
            {detail.readings.map((reading) => (
              <li key={reading.reading} className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 text-sm font-medium">{reading.reading}</span>
                <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {formatCount(reading.count)}×
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {reading.words.join("、")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          /* Said out loud rather than left blank: nothing here means "not
             evidenced yet", not "this character has no readings". */
          <p className="text-xs leading-relaxed text-muted-foreground">
            None pinned down yet. A reading is listed only where a word&apos;s own kana
            fix it to this character — 食べる says 食 is た, while 日本語 never says
            which part of にほんご is 日.
          </p>
        )}
      </section>

      <Separator />

      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Words using it
          </h3>
          {detail.words.length < detail.wordCount && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => onSearchWords(detail.character)}
            >
              all {formatCount(detail.wordCount)}
            </button>
          )}
        </div>
        <ul className="divide-y divide-border/60">
          {detail.words.map((word) => (
            <li key={word.lemma}>
              <button
                type="button"
                onClick={() => onOpenWord(word.lemma)}
                className="flex w-full items-baseline gap-2 py-1.5 text-left transition-colors hover:bg-accent/30"
              >
                <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {formatCount(word.count)}×
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{word.lemma}</span>
                    {word.reading && word.reading !== word.lemma && (
                      <span className="text-[11px] text-muted-foreground">{word.reading}</span>
                    )}
                    {/* The evidence, where there is any: this word is why the
                        reading above is listed. */}
                    {word.kanjiReading && (
                      <span className="text-[11px] text-muted-foreground/80">
                        {detail.character} = {word.kanjiReading}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {word.senses.length > 0 ? word.senses.join("; ") : "Not looked up yet"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function EmptyLog({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 p-12 text-center">
      <BookMarked className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">
        {hasFilter ? "Nothing matches that" : "No words yet"}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {hasFilter
          ? "Try a different search, or clear the filters."
          : "Every word in every transcript you generate is logged here, with how often it comes up and the lines you met it in."}
      </p>
    </div>
  );
}

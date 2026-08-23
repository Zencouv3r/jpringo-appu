"use client";

import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, Play, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import * as ipc from "@/lib/ipc";
import type {
  JlptLevel,
  PartOfSpeech,
  Segment,
  Term,
  Token,
  VocabEntry,
} from "@/lib/types";
import { JLPT_CLASS, cn, formatCount } from "@/lib/utils";

export interface WordSelection {
  token: Token;
  segment: Segment;
}

const POS_LABEL: Record<PartOfSpeech, string> = {
  noun: "noun",
  verb: "verb",
  adjective: "adjective",
  adverb: "adverb",
  particle: "particle",
  auxiliaryVerb: "auxiliary",
  conjunction: "conjunction",
  prefix: "prefix",
  interjection: "interjection",
  determiner: "determiner",
  symbol: "symbol",
  other: "",
};

interface WordPanelProps {
  selection: WordSelection | null;
  onClose: () => void;
  onReplay: (time: number) => void;
  /** Opens the dictionary screen focused on this word. */
  onOpenDictionary?: (lemma: string) => void;
}

/** The dictionary form a word is filed under. */
function lemmaOf(token: Token): string {
  return token.base.trim() || token.surface;
}

/**
 * Details for the word the user clicked.
 *
 * Three sources meet here, and the distinction between them is the point.
 * Lindera supplies the reading, dictionary form, and part of speech — always
 * present, offline, instantly. The vocabulary store supplies the *senses*: the
 * two or three things this word can mean, looked up once and reused forever.
 * The breakdown supplies what it means **here**, plus how the grammar works,
 * which is regenerated per video because it is only true of this line.
 */
export function WordPanel({
  selection,
  onClose,
  onReplay,
  onOpenDictionary,
}: WordPanelProps) {
  // Keyed by the word it was fetched for, so a result arriving after the user
  // has clicked elsewhere is ignored rather than shown under the wrong
  // heading. The store is in memory on the Rust side, so this resolves in well
  // under a frame and there is deliberately no loading state to flash.
  const [loaded, setLoaded] = useState<{
    lemma: string;
    entry: VocabEntry | null;
  } | null>(null);
  const lemma = selection ? lemmaOf(selection.token) : null;

  useEffect(() => {
    if (!lemma) return;
    let cancelled = false;
    void ipc
      .getWord(lemma)
      .then((found) => {
        if (!cancelled) setLoaded({ lemma, entry: found });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ lemma, entry: null });
      });
    return () => {
      cancelled = true;
    };
  }, [lemma]);

  const entry = loaded?.lemma === lemma ? loaded.entry : null;

  if (!selection || !lemma) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BookOpen className="size-5 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">
          Click any word in the transcript to see what it means here.
        </p>
      </div>
    );
  }

  const { token, segment } = selection;
  const term = findTerm(token, segment.terms);
  // Terms the model flagged that aren't the clicked word — usually multi-word
  // grammar patterns, which no single token can match.
  const otherTerms = segment.terms.filter((candidate) => candidate !== term);

  const reading = entry?.reading || token.reading;
  const level = pickLevel(entry?.jlptLevel, term?.jlptLevel);
  const senses = entry?.senses ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xl leading-tight font-medium">{token.surface}</span>
            {reading && reading !== token.surface && (
              <span className="text-sm text-muted-foreground">{reading}</span>
            )}
            {level !== "none" && (
              <Badge className={cn("text-[10px]", JLPT_CLASS[level])}>{level}</Badge>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {(entry?.partOfSpeech || POS_LABEL[token.pos]) && (
              <span>{entry?.partOfSpeech || POS_LABEL[token.pos]}</span>
            )}
            {token.base !== token.surface && (
              <>
                <span aria-hidden>·</span>
                <span>
                  from <span className="text-foreground/80">{token.base}</span>
                </span>
              </>
            )}
            {entry && entry.count > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>seen {formatCount(entry.count)}×</span>
              </>
            )}
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {/* Dictionary senses first: they are what the word *is*, and they are
            here on every word whether or not this video was ever explained. */}
        {senses.length > 0 ? (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Meanings
            </h3>
            <ol className="space-y-0.5">
              {senses.map((sense, index) => (
                <li key={index} className="flex gap-2 text-sm leading-relaxed">
                  {senses.length > 1 && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {index + 1}.
                    </span>
                  )}
                  <span>{sense}</span>
                </li>
              ))}
            </ol>
            {entry?.note && (
              <p className="text-xs leading-relaxed text-muted-foreground">{entry.note}</p>
            )}
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            No dictionary entry for this word yet — generate the explanations to look
            it up. Its reading and dictionary form above come from the tokenizer and
            are always available.
          </p>
        )}

        {/* Then what it means *here*, which is a different question. */}
        {term && (term.meaning || term.grammar || term.note) && (
          <>
            <Separator />
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                In this line
              </h3>
              {term.meaning && <p className="text-sm leading-relaxed">{term.meaning}</p>}
              {term.grammar && (
                <p className="rounded-[1.5px] bg-muted/60 p-2 text-xs leading-relaxed">
                  {term.grammar}
                </p>
              )}
              {term.note && (
                <p className="rounded-[1.5px] bg-muted/60 p-2 text-xs leading-relaxed text-muted-foreground">
                  {term.note}
                </p>
              )}
            </section>
          </>
        )}

        <Separator />

        <section className="space-y-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            In context
          </h3>
          <p className="text-[15px] leading-loose">{highlight(segment.text, token)}</p>
          {segment.translation && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {segment.translation}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs rounded-[2.67px]"
              onClick={() => onReplay(segment.start)}
            >
              <Play className="size-3" />
              Replay this line
            </Button>
            {onOpenDictionary && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs rounded-[2.67px]"
                onClick={() => onOpenDictionary(lemma)}
              >
                <ExternalLink className="size-3" />
                Open in dictionary
              </Button>
            )}
          </div>
        </section>

        {otherTerms.length > 0 && (
          <>
            <Separator />
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Also in this line
              </h3>
              {otherTerms.map((other, index) => (
                <div key={`${other.term}-${index}`} className="space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-sm font-medium">{other.term}</span>
                    {other.reading && other.reading !== other.term && (
                      <span className="text-xs text-muted-foreground">{other.reading}</span>
                    )}
                    {other.jlptLevel !== "none" && (
                      <Badge className={cn("text-[10px]", JLPT_CLASS[other.jlptLevel])}>
                        {other.jlptLevel}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {other.meaning}
                    {other.grammar && ` — ${other.grammar}`}
                    {other.note && ` — ${other.note}`}
                  </p>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** The more specific of the two levels we may hold for a word. */
function pickLevel(
  stored: JlptLevel | undefined,
  contextual: JlptLevel | undefined,
): JlptLevel {
  if (stored && stored !== "none") return stored;
  if (contextual && contextual !== "none") return contextual;
  return "none";
}

/**
 * Matches a clicked token to one of the model's terms.
 *
 * Tried in descending order of confidence: the exact surface form, then the
 * dictionary form (the model is asked to cite 食べる where the line reads
 * 食べた), then containment in either direction for terms that span a token
 * boundary.
 */
function findTerm(token: Token, terms: Term[]): Term | undefined {
  return (
    terms.find((term) => term.term === token.surface) ??
    terms.find((term) => term.term === token.base) ??
    terms.find(
      (term) =>
        term.term.length > 1 &&
        (term.term.includes(token.surface) || term.term.includes(token.base)),
    ) ??
    terms.find((term) => token.surface.includes(term.term) && term.term.length > 1)
  );
}

/** Renders the segment with the selected token marked. */
function highlight(text: string, token: Token) {
  const chars = [...text];
  if (token.start >= token.end || token.end > chars.length) return text;

  return (
    <>
      {chars.slice(0, token.start).join("")}
      <mark className="rounded-[3px] bg-primary/20 px-0 text-foreground">
        {chars.slice(token.start, token.end).join("")}
      </mark>
      {chars.slice(token.end).join("")}
    </>
  );
}

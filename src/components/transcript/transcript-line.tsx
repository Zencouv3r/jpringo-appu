"use client";

import { memo, useMemo } from "react";

import { TRANSCRIPT_FONT_SIZE_VAR } from "@/lib/appearance";
import { splitIntoPieces } from "@/lib/tokens";
import type { PartOfSpeech, Segment, Token } from "@/lib/types";
import { cn, formatTimestamp } from "@/lib/utils";

/**
 * Parts of speech that get a colour.
 *
 * Deliberately sparse: tinting every word turns the transcript into confetti
 * and stops any one colour meaning anything. Verbs and adjectives carry the
 * information a learner is usually parsing for, and particles are tinted down
 * rather than up because they are grammatical scaffolding.
 */
const POS_CLASS: Partial<Record<PartOfSpeech, string>> = {
  verb: "text-emerald-600 dark:text-emerald-400",
  adjective: "text-amber-600 dark:text-amber-400",
  particle: "text-muted-foreground/70",
  auxiliaryVerb: "text-muted-foreground/70",
};

interface TranscriptLineProps {
  segment: Segment;
  isActive: boolean;
  selectedToken: Token | null;
  showTranslation: boolean;
  onSeek: (time: number) => void;
  onSelectWord: (token: Token, segment: Segment) => void;
}

function TranscriptLineImpl({
  segment,
  isActive,
  selectedToken,
  showTranslation,
  onSeek,
  onSelectWord,
}: TranscriptLineProps) {
  const pieces = useMemo(() => splitIntoPieces(segment), [segment]);

  return (
    <div
      data-segment-id={segment.id}
      className={cn(
        "group/line scroll-mt-4 border-l-2 px-3 py-2 transition-colors",
        isActive
          ? "border-l-primary bg-accent/60"
          : "border-l-transparent hover:bg-accent/30",
      )}
    >
      <div className="flex items-baseline gap-2.5">
        <button
          type="button"
          onClick={() => onSeek(segment.start)}
          className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`Jump to ${formatTimestamp(segment.start)}`}
        >
          {formatTimestamp(segment.start)}
        </button>

        {/* Sized from the custom property `useAppearance` writes, so the
            text being studied can grow without inflating the chrome. */}
        <p
          style={{ fontSize: `var(${TRANSCRIPT_FONT_SIZE_VAR}, 15px)` }}
          className="min-w-0 flex-1 leading-loose"
        >
          {pieces.map((piece, index) =>
            piece.token ? (
              <WordSpan
                key={index}
                token={piece.token}
                text={piece.text}
                isSelected={
                  selectedToken !== null &&
                  selectedToken.start === piece.token.start &&
                  selectedToken.surface === piece.token.surface &&
                  isActive
                }
                onSelect={() => onSelectWord(piece.token!, segment)}
              />
            ) : (
              <span key={index}>{piece.text}</span>
            ),
          )}
        </p>
      </div>

      {showTranslation && segment.translation && (
        <p
          // Kept proportional to the line above it rather than fixed: the
          // translation is the glance, not the thing being read.
          style={{ fontSize: `calc(var(${TRANSCRIPT_FONT_SIZE_VAR}, 15px) * 0.87)` }}
          className="mt-1 pl-[3.4rem] leading-relaxed text-muted-foreground"
        >
          {segment.translation}
        </p>
      )}
    </div>
  );
}

/** Re-renders are driven by playback, so the cheap identity checks pay off. */
export const TranscriptLine = memo(TranscriptLineImpl);

function WordSpan({
  token,
  text,
  isSelected,
  onSelect,
}: {
  token: Token;
  text: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  if (!token.clickable) {
    return <span className={cn(POS_CLASS[token.pos])}>{text}</span>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      title={token.reading || undefined}
      className={cn(
        "rounded-[3px] transition-colors",
        // No horizontal padding: Japanese has no word gaps, and adding any
        // would visibly re-space the sentence.
        "hover:bg-primary/15 hover:underline hover:decoration-primary/60 hover:underline-offset-4",
        isSelected && "bg-primary/20 underline decoration-primary underline-offset-4",
        POS_CLASS[token.pos],
      )}
    >
      {text}
    </button>
  );
}


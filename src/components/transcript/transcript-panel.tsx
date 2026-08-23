"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  ArrowLeftRight,
  AudioLines,
  Languages,
  ListX,
  Loader2,
  PanelLeftClose,
  PanelRightClose,
  Sparkles,
  X,
} from "lucide-react";

import { TranscriptLine } from "@/components/transcript/transcript-line";
import { TranscriptSourceMenu } from "@/components/transcript/transcript-source-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useAnalysis } from "@/hooks/use-analysis";
import type { TranscriptSide } from "@/lib/layout";
import type { Segment, SubtitleTrack, Token } from "@/lib/types";
import { cn, describeStage, stagePercent, transcriptLanguageLabel } from "@/lib/utils";

interface TranscriptPanelProps {
  analysis: ReturnType<typeof useAnalysis>;
  activeSegmentIndex: number;
  selectedToken: Token | null;
  hasApiKey: boolean;
  subtitleTracks: SubtitleTrack[];
  externalSubtitles: string[];
  /** Which side of the video the panel is currently on. */
  side: TranscriptSide;
  /** Sends it to the other side. */
  onSwapSide: () => void;
  /** Puts it away; the toggle in the header is what brings it back. */
  onHide: () => void;
  onSeek: (time: number) => void;
  onSelectWord: (token: Token, segment: Segment) => void;
  onOpenSettings: () => void;
}

export function TranscriptPanel({
  analysis: state,
  activeSegmentIndex,
  selectedToken,
  hasApiKey,
  subtitleTracks,
  externalSubtitles,
  side,
  onSwapSide,
  onHide,
  onSeek,
  onSelectWord,
  onOpenSettings,
}: TranscriptPanelProps) {
  const {
    analysis,
    choice,
    setChoice,
    status,
    stage,
    error,
    transcribe,
    explain,
    reload,
    cancel,
    isRunning,
    isJapanese,
  } = state;
  const [showTranslations, setShowTranslations] = useState(true);
  const [query, setQuery] = useState("");
  const [autoFollow, setAutoFollow] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stable identity: this feeds the follow-playback effect below, and a
  // fresh `[]` each render would re-run it on every tick.
  const segments = useMemo(() => analysis?.segments ?? [], [analysis]);

  const filtered = query.trim()
    ? segments.filter(
        (segment) =>
          segment.text.includes(query.trim()) ||
          segment.translation.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : segments;

  // Follow playback, unless the user is searching (where scrolling away from
  // their results would be hostile) or has scrolled off on their own.
  useEffect(() => {
    if (!autoFollow || query.trim() || activeSegmentIndex < 0) return;
    const container = scrollRef.current;
    if (!container) return;

    const line = container.querySelector(
      `[data-segment-id="${segments[activeSegmentIndex]?.id}"]`,
    );
    line?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeSegmentIndex, autoFollow, query, segments]);

  // Any manual scroll suspends following until the user opts back in.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    // Only pointer-driven scrolling counts. Listening for `scroll` instead
    // would catch the smooth scroll the follow effect below performs and
    // switch off the very thing that caused it, one line in.
    const onScrollAway = () => setAutoFollow(false);
    container.addEventListener("wheel", onScrollAway, { passive: true });
    container.addEventListener("touchmove", onScrollAway, { passive: true });
    return () => {
      container.removeEventListener("wheel", onScrollAway);
      container.removeEventListener("touchmove", onScrollAway);
    };
  }, []);

  const percent = stage ? stagePercent(stage) : null;
  const languageName = analysis
    ? transcriptLanguageLabel(analysis.language, analysis.script)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <AlignLeft className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="shrink-0 text-sm font-medium">Transcript</h2>

          <TranscriptSourceMenu
            choice={choice}
            onChoose={setChoice}
            onTranscribe={() => void transcribe(false)}
            subtitleTracks={subtitleTracks}
            externalSubtitles={externalSubtitles}
            activeSource={analysis?.source ?? null}
          />

          {/* Named only when it isn't Japanese: on a Japanese transcript the
              label is noise, but on any other it is the explanation for why
              there are no translations underneath. */}
          {analysis && !isJapanese && languageName && (
            <Tooltip>
              <TooltipTrigger
                // Gives way with the source badge when the panel is dragged
                // narrow; the full name is in the notice below the header,
                // which is the thing actually explaining the situation.
                render={<Badge variant="secondary" className="min-w-0 shrink text-[10px]" />}
              >
                {languageName}
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Ringo can show this track, but word breakdowns and translations are
                Japanese-only.
              </TooltipContent>
            </Tooltip>
          )}

          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {segments.length > 0 && `${segments.length} lines`}
          </span>

          {segments.length > 0 && isJapanese && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={showTranslations ? "Hide translations" : "Show translations"}
                    onClick={() => setShowTranslations((value) => !value)}
                  />
                }
              >
                <Languages
                  className={cn("size-4", !showTranslations && "text-muted-foreground/50")}
                />
              </TooltipTrigger>
              <TooltipContent>
                {showTranslations ? "Hide translations" : "Show translations"}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Where the panel lives, kept with the panel rather than filed away
              in Settings: which side reads better depends on where the picture
              puts its own burned-in text, and that changes from one file to
              the next. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={
                    side === "right"
                      ? "Move the transcript to the left"
                      : "Move the transcript to the right"
                  }
                  onClick={onSwapSide}
                />
              }
            >
              <ArrowLeftRight className="size-4" />
            </TooltipTrigger>
            <TooltipContent>
              {side === "right" ? "Move to the left" : "Move to the right"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Hide the transcript"
                  onClick={onHide}
                />
              }
            >
              {side === "right" ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </TooltipTrigger>
            <TooltipContent>Hide the transcript (t)</TooltipContent>
          </Tooltip>
        </div>

        {segments.length > 0 && (
          <div className="relative">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the transcript…"
              className="h-8 pr-8 text-sm"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        )}
      </header>

      {isRunning && (
        <div className="shrink-0 space-y-1.5 border-b border-border bg-muted/40 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {stage ? describeStage(stage) : "Starting…"}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {/* An indeterminate value renders as a pulsing track, which is the
              honest signal during stages that can't report a percentage. */}
          <Progress value={percent} className="gap-0" />
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {status === "error" && error && (
          <div className="m-3 rounded-[1.5px] border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-destructive">That didn&apos;t work</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void reload(true)}>
              Try again
            </Button>
          </div>
        )}

        {!analysis && !isRunning && status !== "error" && status !== "loading" && (
          <EmptyTranscript
            hasSubtitles={subtitleTracks.some((t) => t.textual) || externalSubtitles.length > 0}
            onTranscribe={() => void transcribe(false)}
            onLoadTrack={() => void reload(false)}
            isTrackChosen={choice.kind === "embedded" || choice.kind === "external"}
          />
        )}

        {analysis && filtered.length === 0 && query.trim() && (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <ListX className="size-5" />
            <p>No lines match “{query.trim()}”.</p>
          </div>
        )}

        {/* The prompt to run the paid pass. Only Japanese gets it, because
            only Japanese has anything to explain. */}
        {analysis && isJapanese && !analysis.analyzed && !isRunning && (
          <div className="m-3 rounded-[1.5px] border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Transcript only</p>
            <p className="mt-1 text-muted-foreground">
              {hasApiKey
                ? "Every word is clickable for its reading and dictionary form. Explanations add a translation for each line and what each word means in context."
                : "Add an OpenAI API key to get translations and word explanations."}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={hasApiKey ? () => void explain() : onOpenSettings}
            >
              {hasApiKey ? (
                <>
                  <Sparkles className="size-3.5" />
                  Generate explanations
                </>
              ) : (
                "Open settings"
              )}
            </Button>
          </div>
        )}

        {analysis && !isJapanese && !isRunning && (
          <div className="m-3 rounded-[1.5px] border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Reading only</p>
            <p className="mt-1 text-muted-foreground">
              This track is {languageName}. You can read along with it, but word
              breakdowns and explanations only work on Japanese — pick a Japanese
              track, or transcribe the audio.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void transcribe(false)}
            >
              <AudioLines className="size-3.5 rounded-[2.2px]" />
              Transcribe audio
            </Button>
          </div>
        )}

        {filtered.map((segment) => (
          <TranscriptLine
            key={segment.id}
            segment={segment}
            isActive={segments[activeSegmentIndex]?.id === segment.id}
            selectedToken={selectedToken}
            showTranslation={showTranslations}
            onSeek={onSeek}
            onSelectWord={onSelectWord}
          />
        ))}
      </div>

      {!autoFollow && segments.length > 0 && !query.trim() && (
        <div className="shrink-0 border-t border-border p-2">
          <Button
            variant="secondary"
            size="sm"
            className="w-full text-xs"
            onClick={() => setAutoFollow(true)}
          >
            Follow playback
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What the panel shows before there is anything to show.
 *
 * A file with subtitle tracks has already tried to load one by the time this
 * renders, so reaching here means either there were none or the one picked
 * failed — in both cases the offer is whisper, which is the only remaining way
 * to get a transcript out of the file.
 */
function EmptyTranscript({
  hasSubtitles,
  isTrackChosen,
  onTranscribe,
  onLoadTrack,
}: {
  hasSubtitles: boolean;
  isTrackChosen: boolean;
  onTranscribe: () => void;
  onLoadTrack: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <AudioLines className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No transcript yet</p>
        <p className="text-sm text-muted-foreground">
          {hasSubtitles
            ? "Pick a subtitle track from the menu above to read along with it, or transcribe the audio locally with whisper."
            : "This file has no text subtitle tracks. Whisper can transcribe the audio locally — expect several minutes for an episode."}
        </p>
      </div>
      {isTrackChosen ? (
        <Button size="sm" onClick={onLoadTrack}>
          Load this track
        </Button>
      ) : (
        <Button size="sm" onClick={onTranscribe}>
          <AudioLines className="size-3.5 rounded-[2.3px]" />
          Transcribe audio
        </Button>
      )}
    </div>
  );
}

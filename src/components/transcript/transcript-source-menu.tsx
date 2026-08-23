"use client";

import { Check, ChevronDown, FileText, Sparkles, Wand2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SubtitleTrack, TranscriptChoice, TranscriptSource } from "@/lib/types";
import { transcriptChoiceKey } from "@/lib/types";
import { languageLabel } from "@/lib/utils";

const SOURCE_LABEL: Record<TranscriptSource, string> = {
  embeddedSubtitles: "Embedded subtitles",
  externalSubtitles: "Subtitle file",
  whisper: "Generated",
};

interface TranscriptSourceMenuProps {
  choice: TranscriptChoice;
  onChoose: (choice: TranscriptChoice) => void;
  /** Starts a whisper run. Picking it from here is as explicit as the button. */
  onTranscribe: () => void;
  subtitleTracks: SubtitleTrack[];
  externalSubtitles: string[];
  /** Where the *currently loaded* transcript actually came from, if any —
   * shown as the trigger's label even when `choice` is still `auto`. */
  activeSource: TranscriptSource | null;
}

/**
 * Lets the user override which transcript source the pipeline uses.
 *
 * Picking a subtitle track loads it immediately — reading one is local and
 * takes about a second — so this menu is how you switch languages mid-episode.
 *
 * Hidden when there is nothing to choose between: a file with no subtitle
 * tracks at all only has one possible source (whisper), so a menu offering
 * "Auto" and "Whisper" as the only two options would just be confusing noise
 * over what already happens by default.
 */
export function TranscriptSourceMenu({
  choice,
  onChoose,
  onTranscribe,
  subtitleTracks,
  externalSubtitles,
  activeSource,
}: TranscriptSourceMenuProps) {
  const embedded = subtitleTracks.filter((t) => t.textual);
  if (embedded.length === 0 && externalSubtitles.length === 0) {
    return null;
  }

  const currentKey = transcriptChoiceKey(choice);
  const triggerLabel =
    choice.kind === "auto" && activeSource
      ? SOURCE_LABEL[activeSource]
      : describeChoice(choice, embedded);

  return (
    <DropdownMenu>
      {/* The badge renders as a real `<button>`: Base UI's trigger assumes a
          native button unless told otherwise, and a `<span>` here loses the
          keyboard and form semantics that come with one. */}
      <DropdownMenuTrigger
        render={
          <Badge
            variant="outline"
            // The one item in the header whose width is the file's choice
            // rather than ours, so it is the one that gives when the panel is
            // dragged narrow: everything else there is a fixed-size control,
            // and the whole name is a menu away.
            className="min-w-0 shrink cursor-pointer gap-1 text-[10px] hover:bg-accent"
            render={<button type="button" />}
          />
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="size-2.5 shrink-0" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onClick={() => onChoose({ kind: "auto" })}>
          <Sparkles className="size-3.5" />
          <span className="flex-1">Auto</span>
          {currentKey === "auto" && <Check className="size-3.5" />}
        </DropdownMenuItem>

        {embedded.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {/* Base UI's `GroupLabel` labels the group it sits in and throws
                when there isn't one, so each heading brings its own group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Embedded subtitles</DropdownMenuLabel>
              {embedded.map((track) => {
                const key = transcriptChoiceKey({ kind: "embedded", value: track.index });
                return (
                  <DropdownMenuItem
                    key={track.index}
                    onClick={() => onChoose({ kind: "embedded", value: track.index })}
                  >
                    <FileText className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{describeTrack(track)}</span>
                    {currentKey === key && <Check className="size-3.5 shrink-0" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}

        {externalSubtitles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Subtitle files</DropdownMenuLabel>
              {externalSubtitles.map((path) => {
                const key = transcriptChoiceKey({ kind: "external", value: path });
                return (
                  <DropdownMenuItem key={path} onClick={() => onChoose({ kind: "external", value: path })}>
                    <FileText className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{fileName(path)}</span>
                    {currentKey === key && <Check className="size-3.5 shrink-0" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onTranscribe}>
          <Wand2 className="size-3.5" />
          <span className="flex-1">Transcribe the audio instead</span>
          {currentKey === "whisper" && <Check className="size-3.5" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The trigger's label. An embedded pick is named by its track rather than by
 * its stream index — "Track 4" is an ffprobe implementation detail, and the
 * menu the user just picked from showed them "Japanese · default".
 */
function describeChoice(choice: TranscriptChoice, embedded: SubtitleTrack[]): string {
  switch (choice.kind) {
    case "auto":
      return "Auto";
    case "whisper":
      return "Generated";
    case "embedded": {
      const track = embedded.find((t) => t.index === choice.value);
      return track ? describeTrack(track) : `Track ${choice.value}`;
    }
    case "external":
      return fileName(choice.value);
  }
}

function describeTrack(track: SubtitleTrack): string {
  const parts: string[] = [];
  parts.push(track.title || (track.language ? languageLabel(track.language) : `Track ${track.index}`));
  if (track.forced) parts.push("forced");
  if (track.default) parts.push("default");
  return parts.join(" · ");
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

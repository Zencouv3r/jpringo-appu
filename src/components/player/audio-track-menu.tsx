"use client";

import { Check, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AudioTrack } from "@/lib/types";
import { languageLabel } from "@/lib/utils";

interface AudioTrackMenuProps {
  tracks: AudioTrack[];
  /** Absolute stream index of the active track, or `null` for the default. */
  current: number | null;
  onSelect: (track: number | null) => void;
}

/**
 * Lets the user pick among a file's audio tracks — a second language dub, a
 * commentary track, whatever the release carries.
 *
 * Hidden entirely when there's only one track: WebView2 has no `audioTracks`
 * API, so every switch is a remux, and offering a menu with one inert item
 * that does nothing would be worse than no menu at all.
 */
export function AudioTrackMenu({ tracks, current, onSelect }: AudioTrackMenuProps) {
  if (tracks.length < 2) return null;

  // `null` means "whatever the file plays by default", which is one of the
  // tracks listed here — resolving it puts the check mark on the track that is
  // actually playing instead of on nothing at all. `0:a:0` is what ffmpeg maps
  // when no track is requested, so the first audio stream is the honest answer.
  const activeIndex = current ?? tracks[0]?.index ?? null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Audio track"
                  className="size-8 text-white hover:bg-white/15 hover:text-white"
                />
              }
            />
          }
        >
          <Volume2 className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Audio track</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" side="top">
        {/* The label has to live inside a group — Base UI's `GroupLabel` reads
            the group's context to label it, and throws outright without one. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Audio track</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tracks.map((track) => (
            <DropdownMenuItem key={track.index} onClick={() => onSelect(track.index)}>
              <span className="min-w-0 flex-1 truncate">{describeTrack(track)}</span>
              {activeIndex === track.index && <Check className="size-3.5 shrink-0" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function describeTrack(track: AudioTrack): string {
  const parts: string[] = [];
  if (track.title) {
    parts.push(track.title);
  } else if (track.language) {
    parts.push(languageLabel(track.language));
  } else {
    parts.push(`Track ${track.index}`);
  }
  if (track.channels) parts.push(track.channels === 2 ? "stereo" : `${track.channels}ch`);
  if (track.default) parts.push("default");
  return parts.join(" · ");
}

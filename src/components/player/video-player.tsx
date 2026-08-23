"use client";

import { useEffect, useState } from "react";
import {
  EyeOff,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rewind,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";

import { AudioTrackMenu } from "@/components/player/audio-track-menu";
import { SeekBar } from "@/components/player/seek-bar";
import { SubtitleMenu } from "@/components/player/subtitle-menu";
import { SubtitleOverlay } from "@/components/player/subtitle-overlay";
import type { WordSelection } from "@/components/word/word-panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHROME_PROPS } from "@/hooks/use-immersive";
import type { usePlayer } from "@/hooks/use-player";
import type { useSubtitleStyle } from "@/hooks/use-subtitle-style";
import type { PlaybackKeys } from "@/lib/playback";
import type { AudioTrack, Segment, Token } from "@/lib/types";
import { cn, formatTimestamp } from "@/lib/utils";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

interface VideoPlayerProps {
  player: ReturnType<typeof usePlayer>;
  title: string;
  segments: Segment[];
  /** The line to draw over the video, or `null` between lines. */
  subtitleSegment: Segment | null;
  subtitles: ReturnType<typeof useSubtitleStyle>;
  /** The word open in the panel, so the subtitle can mark it too. */
  selection: WordSelection | null;
  onSelectWord: (token: Token, segment: Segment) => void;
  audioTracks: AudioTrack[];
  currentAudioTrack: number | null;
  onSwitchAudioTrack: (track: number | null) => void;
  /** Jumps to the start of the line currently being spoken. */
  onReplayLine: () => void;
  /**
   * Jumps to the start of the line `delta` places away — the arrows flanking
   * the subtitle, where -1 is the previous line and 1 the next.
   */
  onStepLine: (delta: number) => void;
  canStepBack: boolean;
  canStepForward: boolean;
  /**
   * What the arrow keys do — step between lines, or jump a fixed number of
   * seconds. Chosen in Settings; see {@link module:lib/playback}.
   */
  arrowKeys: PlaybackKeys;
  /**
   * Closes the file and goes back to the library — the Library button in the
   * header, and `esc` from a window.
   */
  onExitToLibrary: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /**
   * Puts the transcript away, or brings it back — the `t` key. A no-op in
   * fullscreen, where there is no sidebar to put away in the first place.
   */
  onToggleTranscript: () => void;
  /** True while the header and this control bar are hidden — fullscreen only. */
  isChromeHidden: boolean;
  onToggleChrome: () => void;
  /** True while the "press h" hint should sit over the picture. */
  showHideHint: boolean;
  /**
   * False while another screen covers the player, which is what silences the
   * keyboard shortcuts: `space` belongs to whatever is actually on screen.
   */
  hasFocus: boolean;
}

export function VideoPlayer({
  player,
  title,
  segments,
  subtitleSegment,
  subtitles,
  selection,
  onSelectWord,
  audioTracks,
  currentAudioTrack,
  onSwitchAudioTrack,
  onReplayLine,
  onStepLine,
  canStepBack,
  canStepForward,
  arrowKeys,
  onExitToLibrary,
  isFullscreen,
  onToggleFullscreen,
  onToggleTranscript,
  isChromeHidden,
  onToggleChrome,
  showHideHint,
  hasFocus,
}: VideoPlayerProps) {
  const {
    attach,
    currentTime,
    duration,
    isPlaying,
    isBuffering,
    volume,
    isMuted,
    playbackRate,
    togglePlay,
    seek,
    skip,
    setVolume,
    toggleMute,
    setPlaybackRate,
  } = player;

  const toggleSubtitles = subtitles.toggle;
  // Whether the arrows have lines to step through at all. A boolean rather
  // than the array itself, so the key handler is not re-bound every time the
  // transcript object changes identity.
  const hasLines = segments.length > 0;
  // Open state lives here rather than inside the menu, because the overlay
  // needs it too: while the menu is open both blocks show, so there is always
  // something to drag even in a silence.
  const [isTuningSubtitles, setIsTuningSubtitles] = useState(false);

  // Space, arrows, and the usual media keys, scoped to the window but ignored
  // while a text field has focus so typing an API key doesn't scrub the video.
  useEffect(() => {
    if (!hasFocus) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          event.preventDefault();
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          // Lines by default, but a file whose transcript hasn't been made
          // yet has none to step through: falling back to the jump leaves the
          // key doing something rather than nothing.
          if (arrowKeys.arrows === "line" && hasLines) onStepLine(direction);
          else skip(direction * arrowKeys.seekSeconds);
          break;
        }
        case "j":
          event.preventDefault();
          skip(-10);
          break;
        case "l":
          event.preventDefault();
          skip(10);
          break;
        case "m":
          event.preventDefault();
          toggleMute();
          break;
        case "r":
          event.preventDefault();
          onReplayLine();
          break;
        case "f":
          event.preventDefault();
          onToggleFullscreen();
          break;
        case "c":
          event.preventDefault();
          toggleSubtitles();
          break;
        case "h":
          event.preventDefault();
          onToggleChrome();
          break;
        case "t":
          event.preventDefault();
          onToggleTranscript();
          break;
        case "Escape":
          // Swallowed in fullscreen on purpose. `esc` is the reflex for
          // getting out of things, and the thing it would get you out of here
          // is the mode the subtitles exist for — one stray press in the
          // middle of an episode and the window is back. `f` leaves
          // fullscreen, and says so on the button that does it.
          event.preventDefault();
          if (!isFullscreen) onExitToLibrary();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    hasFocus,
    togglePlay,
    skip,
    toggleMute,
    onReplayLine,
    onStepLine,
    hasLines,
    arrowKeys,
    isFullscreen,
    onExitToLibrary,
    onToggleFullscreen,
    toggleSubtitles,
    onToggleChrome,
    onToggleTranscript,
  ]);

  const markers = segments.length > 0 ? segments.map((s) => s.start) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black">
      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center",
          // A pointer left over the picture is as much interface as the bar
          // it came from. It comes back with everything else, on the first
          // movement.
          isChromeHidden && "cursor-none",
        )}
      >
        {/* No `src` here: `usePlayer` assigns it, because a source swap has to
            carry the playback position into the new URL. */}
        <video
          ref={attach}
          className="h-full max-h-full w-full object-contain"
          // The custom control bar below is the only surface; the native one
          // would duplicate it and cannot express approximate seeking.
          controls={false}
          onClick={togglePlay}
          onDoubleClick={onToggleFullscreen}
        />

        {isBuffering && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-10 animate-spin text-white/80" />
          </div>
        )}

        {!isPlaying && !isBuffering && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors hover:bg-black/30"
          >
            <span className="flex size-16 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/20">
              <Play className="size-7 translate-x-0.5 fill-white text-white" />
            </span>
          </button>
        )}

        {/* Says the one thing about fullscreen that isn't discoverable. It
            leaves on its own after a few seconds, or the moment the key it
            names is pressed — whichever happens first. */}
        {showHideHint && (
          <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-[1.5px] bg-black/70 px-3 py-1.5 text-xs text-white/90 ring-1 ring-white/15">
            Press <kbd className="font-mono font-medium text-white">H</kbd> to hide the
            interface
          </div>
        )}

        {/* Last, so it paints above the play overlay — otherwise clicking a
            word while paused would hit the resume button instead. */}
        <SubtitleOverlay
          segment={subtitleSegment}
          style={subtitles.style}
          selection={selection}
          onSelectWord={onSelectWord}
          onMove={subtitles.move}
          isAdjusting={isTuningSubtitles}
          onStepLine={onStepLine}
          canStepBack={canStepBack}
          canStepForward={canStepForward}
        />
      </div>

      <div
        {...CHROME_PROPS}
        className={cn(
          "flex flex-col gap-1 bg-neutral-950 px-3 pt-1 pb-2 text-white",
          isChromeHidden && "hidden",
        )}
      >
        <SeekBar
          currentTime={currentTime}
          duration={duration}
          onSeek={seek}
          markers={markers}
        />

        <div className="flex items-center gap-1">
          <ControlButton
            label={isPlaying ? "Pause (space)" : "Play (space)"}
            onClick={togglePlay}
          >
            {isPlaying ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </ControlButton>

          <ControlButton label="Back 10s (j)" onClick={() => skip(-10)}>
            <SkipBack />
          </ControlButton>
          <ControlButton label="Forward 10s (l)" onClick={() => skip(10)}>
            <SkipForward />
          </ControlButton>
          <ControlButton label="Replay this line (r)" onClick={onReplayLine}>
            <Rewind />
          </ControlButton>

          <div className="ml-1 flex items-center gap-1.5">
            <ControlButton label={isMuted ? "Unmute (m)" : "Mute (m)"} onClick={toggleMute}>
              {isMuted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Volume"
              className="h-1 w-20 cursor-pointer accent-primary"
            />
          </div>

          <span className="ml-2 text-xs tabular-nums text-white/70">
            {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
          </span>

          <span className="mx-2 min-w-0 flex-1 truncate text-center text-xs text-white/50">
            {title}
          </span>

          <SubtitleMenu
            subtitles={subtitles}
            hasTranscript={segments.length > 0}
            hasTranslations={segments.some((segment) => segment.translation)}
            open={isTuningSubtitles}
            onOpenChange={setIsTuningSubtitles}
          />

          <AudioTrackMenu
            tracks={audioTracks}
            current={currentAudioTrack}
            onSelect={onSwitchAudioTrack}
          />

          <Select
            value={String(playbackRate)}
            onValueChange={(value) => setPlaybackRate(Number(value))}
          >
            <SelectTrigger
              size="sm"
              className="h-7 w-[4.5rem] border-white/15 bg-transparent text-xs text-white hover:bg-white/10"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAYBACK_RATES.map((rate) => (
                <SelectItem key={rate} value={String(rate)}>
                  {rate}&times;
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Fullscreen only: there is nothing worth hiding in a window, and
              a window with no header has no way back to the library. */}
          {isFullscreen && (
            <ControlButton label="Hide the interface (h)" onClick={onToggleChrome}>
              <EyeOff />
            </ControlButton>
          )}

          <ControlButton
            label={isFullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            onClick={onClick}
            className={cn(
              "size-8 text-white hover:bg-white/15 hover:text-white",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

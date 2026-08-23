"use client";

import { Captions, CaptionsOff, Move, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { useSubtitleStyle } from "@/hooks/use-subtitle-style";
import {
  FONT_SIZE_RANGE,
  MAX_WIDTH_RANGE,
  SUBTITLE_COLORS,
  type SubtitleTrackKey,
  type SubtitleTrackStyle,
} from "@/lib/subtitle-style";
import { cn } from "@/lib/utils";

interface SubtitleMenuProps {
  subtitles: ReturnType<typeof useSubtitleStyle>;
  /** False when there is no transcript to draw, which disables the control. */
  hasTranscript: boolean;
  /** False for a transcript with no translations — the section is hidden. */
  hasTranslations: boolean;
  /** Controlled so the overlay can show placeholder blocks while it is open. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Appearance controls for the on-video subtitles.
 *
 * Everything here is per-track because the two tracks are read differently,
 * and the position is deliberately *not* here: dragging the block itself is a
 * better control than two number fields, so the panel only offers to put them
 * back where they started.
 */
export function SubtitleMenu({
  subtitles,
  hasTranscript,
  hasTranslations,
  open,
  onOpenChange,
}: SubtitleMenuProps) {
  const { style, update, toggle, resetPositions, reset } = subtitles;
  const isOn = style.enabled && hasTranscript;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Subtitles"
                  disabled={!hasTranscript}
                  className={cn(
                    "size-8 text-white hover:bg-white/15 hover:text-white",
                    !isOn && "text-white/40",
                  )}
                />
              }
            />
          }
        >
          {isOn ? <Captions /> : <CaptionsOff />}
        </TooltipTrigger>
        <TooltipContent>
          {hasTranscript ? "Subtitles (c)" : "Generate a transcript first"}
        </TooltipContent>
      </Tooltip>

      <PopoverContent side="top" align="end" className="w-80 gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Subtitles on video</span>
          <Switch checked={style.enabled} onCheckedChange={toggle} />
        </div>

        <div
          className={cn(
            "flex flex-col gap-3 transition-opacity",
            !style.enabled && "pointer-events-none opacity-50",
          )}
        >
          <TrackControls
            label="Japanese"
            track="japanese"
            style={style.japanese}
            onUpdate={update}
          />

          {hasTranslations ? (
            <TrackControls
              label="Translation"
              track="translation"
              style={style.translation}
              onUpdate={update}
            />
          ) : (
            <p className="border-t border-border pt-2.5 text-xs text-muted-foreground">
              Generate the explanations to get a translation line under each
              subtitle.
            </p>
          )}

          <div className="flex items-center gap-2 border-t border-border pt-2.5">
            <Move className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              Drag either line on the video to move it.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={resetPositions}
            >
              <RotateCcw className="size-3" />
              Recentre
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={reset}
          >
            Reset everything to defaults
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TrackControls({
  label,
  track,
  style,
  onUpdate,
}: {
  label: string;
  track: SubtitleTrackKey;
  style: SubtitleTrackStyle;
  onUpdate: (track: SubtitleTrackKey, patch: Partial<SubtitleTrackStyle>) => void;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{label}</span>
        <Switch
          size="sm"
          checked={style.enabled}
          onCheckedChange={(checked) => onUpdate(track, { enabled: checked })}
        />
      </div>

      <div className={cn(!style.enabled && "pointer-events-none opacity-50")}>
        <SliderRow
          label="Size"
          value={style.fontSize}
          min={FONT_SIZE_RANGE.min}
          max={FONT_SIZE_RANGE.max}
          step={1}
          display={`${style.fontSize}px`}
          onChange={(fontSize) => onUpdate(track, { fontSize })}
        />

        <SliderRow
          label="Backdrop"
          value={style.background}
          min={0}
          max={1}
          step={0.05}
          display={`${Math.round(style.background * 100)}%`}
          onChange={(background) => onUpdate(track, { background })}
        />

        <SliderRow
          label="Width"
          value={style.maxWidth}
          min={MAX_WIDTH_RANGE.min}
          max={MAX_WIDTH_RANGE.max}
          step={0.02}
          display={`${Math.round(style.maxWidth * 100)}%`}
          onChange={(maxWidth) => onUpdate(track, { maxWidth })}
        />

        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">Colour</span>
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {SUBTITLE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Use ${color}`}
                onClick={() => onUpdate(track, { color })}
                style={{ backgroundColor: color }}
                className={cn(
                  "size-5 rounded-full ring-1 ring-foreground/20 transition-transform hover:scale-110",
                  style.color.toLowerCase() === color.toLowerCase() &&
                    "ring-2 ring-primary ring-offset-1 ring-offset-popover",
                )}
              />
            ))}
            {/* The native picker covers everything the swatches don't. */}
            <input
              type="color"
              value={normalizeHex(style.color)}
              onChange={(event) => onUpdate(track, { color: event.target.value })}
              aria-label={`${label} colour`}
              className="size-5 cursor-pointer rounded-full border-0 bg-transparent p-0"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        // Base UI hands back an array for a multi-thumb slider; these are all
        // single-thumb, but the type covers both.
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        className="flex-1"
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {display}
      </span>
    </div>
  );
}

/**
 * `<input type="color">` only accepts `#rrggbb`, and silently shows black for
 * anything else — including the perfectly valid CSS colours a hand-edited
 * config might hold.
 */
function normalizeHex(color: string): string {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#ffffff";
}

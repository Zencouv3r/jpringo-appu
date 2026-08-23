"use client";

import { Captions, Monitor, Moon, RotateCcw, Sun, Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import type { useAppearance } from "@/hooks/use-appearance";
import type { usePlaybackKeys } from "@/hooks/use-playback-keys";
import type { useSubtitleStyle } from "@/hooks/use-subtitle-style";
import type { useTheme } from "@/hooks/use-theme";
import {
  TRANSCRIPT_FONT_SIZE_RANGE,
  UI_SCALE_RANGE,
} from "@/lib/appearance";
import {
  SEEK_SECONDS_RANGE,
  SEEK_SECONDS_STEP,
  type ArrowKeyAction,
} from "@/lib/playback";
import { FONT_SIZE_RANGE } from "@/lib/subtitle-style";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** A line worth previewing at: kanji, kana, and punctuation together. */
const SAMPLE_LINE = "今日はいい天気ですね。";
const SAMPLE_TRANSLATION = "Nice weather today, isn't it?";

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const ARROW_ACTIONS: { value: ArrowKeyAction; label: string; icon: typeof Sun }[] = [
  { value: "line", label: "Between lines", icon: Captions },
  { value: "seek", label: "By seconds", icon: Timer },
];

interface AppearanceSettingsProps {
  appearance: ReturnType<typeof useAppearance>;
  subtitles: ReturnType<typeof useSubtitleStyle>;
  playbackKeys: ReturnType<typeof usePlaybackKeys>;
  theme: ReturnType<typeof useTheme>;
}

/**
 * The Customization submenu: how everything is sized, in which theme, and
 * what the arrow keys do.
 *
 * Separated from the rest of Settings because it is a different kind of
 * setting entirely. Everything else in that dialog changes what the app
 * *does* — which model runs, what it costs, where files land — and is stored
 * in `settings.json`. Nothing here leaves the machine or costs anything; it
 * lives in `localStorage` beside the theme, and it is the part a user pokes at
 * repeatedly rather than once.
 *
 * The subtitle sizes are the same values the CC menu on the player edits.
 * They appear here too because "make the text bigger" is one thought, not
 * three, and somebody who has just enlarged the interface will want the
 * subtitles to follow without hunting for another menu.
 *
 * The arrow keys are the odd one out — not a size, but the same kind of
 * per-machine preference, stored the same way and reached from the same place.
 */
export function AppearanceSettings({
  appearance: state,
  subtitles,
  playbackKeys,
  theme,
}: AppearanceSettingsProps) {
  const { appearance, update, reset } = state;
  const { style, update: updateSubtitle } = subtitles;
  const { keys, setArrows, setSeekSeconds } = playbackKeys;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Interface</h3>

        <SliderRow
          label="Interface size"
          value={appearance.uiScale}
          min={UI_SCALE_RANGE.min}
          max={UI_SCALE_RANGE.max}
          step={0.05}
          display={`${Math.round(appearance.uiScale * 100)}%`}
          onChange={(uiScale) => update({ uiScale })}
        />
        <p className="text-xs text-muted-foreground">
          Scales every screen at once — text, buttons, and the width of the
          transcript beside the video. Applies as you drag.
        </p>

        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Theme</span>
          <div className="flex gap-2">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={theme.theme === value ? "default" : "outline"}
                className="flex-1"
                onClick={() => theme.setTheme(value)}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Transcript</h3>

        <SliderRow
          label="Text size"
          value={appearance.transcriptFontSize}
          min={TRANSCRIPT_FONT_SIZE_RANGE.min}
          max={TRANSCRIPT_FONT_SIZE_RANGE.max}
          step={1}
          display={`${appearance.transcriptFontSize}px`}
          onChange={(transcriptFontSize) => update({ transcriptFontSize })}
        />

        {/* Sized from the same numbers rather than from the CSS property, so
            the preview is honest even before the change is committed. */}
        <div className="rounded-[1.5px] border border-border bg-muted/40 px-3 py-2">
          <p
            style={{ fontSize: `${appearance.transcriptFontSize}px` }}
            className="leading-loose"
          >
            {SAMPLE_LINE}
          </p>
          <p
            style={{ fontSize: `${appearance.transcriptFontSize * 0.87}px` }}
            className="leading-relaxed text-muted-foreground"
          >
            {SAMPLE_TRANSLATION}
          </p>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Subtitles on video</h3>

        <SliderRow
          label="Japanese"
          value={style.japanese.fontSize}
          min={FONT_SIZE_RANGE.min}
          max={FONT_SIZE_RANGE.max}
          step={1}
          display={`${style.japanese.fontSize}px`}
          onChange={(fontSize) => updateSubtitle("japanese", { fontSize })}
        />

        <SliderRow
          label="Translation"
          value={style.translation.fontSize}
          min={FONT_SIZE_RANGE.min}
          max={FONT_SIZE_RANGE.max}
          step={1}
          display={`${style.translation.fontSize}px`}
          onChange={(fontSize) => updateSubtitle("translation", { fontSize })}
        />

        <p className="text-xs text-muted-foreground">
          Colour, backdrop, width, and position live behind the CC button on the
          player, where you can see them against the picture.
        </p>
      </section>

      <Separator />

      {/* The one shortcut in the app with two defensible meanings. Everything
          else on this screen is a size; this is here because it is the other
          thing stored on the machine rather than in settings.json, and because
          Settings is where somebody goes looking for it. */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Arrow keys</h3>

        <div className="flex gap-2">
          {ARROW_ACTIONS.map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={keys.arrows === value ? "default" : "outline"}
              className="flex-1"
              onClick={() => setArrows(value)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>

        {keys.arrows === "seek" ? (
          <>
            <SliderRow
              label="Jump by"
              value={keys.seekSeconds}
              min={SEEK_SECONDS_RANGE.min}
              max={SEEK_SECONDS_RANGE.max}
              step={SEEK_SECONDS_STEP}
              display={`${keys.seekSeconds}s`}
              onChange={setSeekSeconds}
            />
            <p className="text-xs text-muted-foreground">
              <Key>j</Key> and <Key>l</Key> keep their own ten seconds either
              way, and <Key>r</Key> still replays the line that is playing.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Left and right go to the start of the previous or next line — the
            same jump as the arrows beside the subtitle, and the reason it is
            the default: where a line begins is something only the transcript
            knows. A file with no transcript yet falls back to{" "}
            {keys.seekSeconds} seconds.
          </p>
        )}
      </section>

      <Separator />

      <Button variant="outline" size="sm" onClick={reset} className="w-full">
        <RotateCcw className="size-3.5" />
        Reset interface and transcript sizes
      </Button>
    </div>
  );
}

/** A key name in running text, matching the hint over the picture. */
function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="font-mono font-medium text-foreground">{children}</kbd>;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="w-28 shrink-0 text-sm">{label}</span>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        // Base UI hands back an array for a multi-thumb slider; these are all
        // single-thumb, but the type covers both.
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        className="flex-1"
      />
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {display}
      </span>
    </div>
  );
}

"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Moon,
  RotateCcw,
  Sun,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import type { useColorScheme } from "@/hooks/use-color-scheme";
import type { useLivePreview } from "@/hooks/use-live-preview";
import type { useTheme } from "@/hooks/use-theme";
import {
  hslToRgb,
  isLight,
  parseColor,
  parseColorOr,
  rgbToHsl,
  toHex,
  toOpaqueHex,
  toRgbaCss,
  type Hsla,
  type Rgba,
} from "@/lib/color";
import {
  COLOR_GROUPS,
  SCHEME_FILE_EXTENSION,
  effectiveColor,
  isDefaultScheme,
  isOverridden,
  overrideCount,
  parseColorSchemeFile,
  schemeFileName,
  serializeColorScheme,
  type ColorMode,
  type ColorTokenMeta,
} from "@/lib/color-scheme";
import * as ipc from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** A checkerboard, so a colour with opacity reads as translucent rather than dull. */
const CHECKERBOARD =
  "conic-gradient(#c8c8c8 0 25%, #ffffff 0 50%, #c8c8c8 0 75%, #ffffff 0) 0 0 / 8px 8px";

const MODES: { value: ColorMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

interface ColorSchemeSettingsProps {
  colors: ReturnType<typeof useColorScheme>;
  theme: ReturnType<typeof useTheme>;
  /** Owned by the dialog, which is the thing that has to fade. */
  preview: ReturnType<typeof useLivePreview>;
}

/**
 * The Appearance submenu: the colour of every part of the interface.
 *
 * There is deliberately no mock interface to preview against. The real one is
 * already on screen, directly behind this dialog, and the dialog fades out of
 * the way for the length of every drag — see {@link useLivePreview}. A
 * miniature would only compete with it, and would be a lie the moment somebody
 * recoloured a part of the app the miniature does not contain.
 *
 * Editing always targets the palette currently on screen, and choosing the
 * other one switches the app's theme to match. A colour cannot be judged
 * against an interface you can't see, and two people have never agreed about
 * which of light and dark a given hue belongs to.
 */
export function ColorSchemeSettings({
  colors,
  theme,
  preview,
}: ColorSchemeSettingsProps) {
  const { scheme, setColor, rename, resetMode, reset, replace } = colors;
  const mode = theme.resolvedTheme;

  // One token open at a time. Four sliders each, eighteen tokens: opening them
  // all at once would be a screen nobody can navigate.
  const [openToken, setOpenToken] = useState<string | null>(null);
  const [status, setStatus] = useState<
    { tone: "ok" | "error"; message: string } | null
  >(null);
  const [isBusy, setIsBusy] = useState(false);

  const changed = overrideCount(scheme);
  const changedHere = Object.keys(scheme[mode]).length;

  const handleExport = async () => {
    setStatus(null);
    setIsBusy(true);
    try {
      const path = await ipc.pickSaveFile({
        title: "Save the colour scheme",
        defaultPath: schemeFileName(scheme),
        filters: [
          { name: "Colour scheme", extensions: [SCHEME_FILE_EXTENSION] },
        ],
      });
      if (!path) return;
      const written = await ipc.writeColorScheme(
        path,
        serializeColorScheme(scheme),
      );
      setStatus({ tone: "ok", message: `Saved to ${written}` });
    } catch (error) {
      setStatus({ tone: "error", message: describe(error) });
    } finally {
      setIsBusy(false);
    }
  };

  const handleImport = async () => {
    setStatus(null);
    setIsBusy(true);
    try {
      const path = await ipc.pickSchemeFile();
      if (!path) return;
      const result = parseColorSchemeFile(await ipc.readColorScheme(path));
      if (!result.ok) {
        setStatus({ tone: "error", message: result.message });
        return;
      }
      replace(result.scheme);
      setOpenToken(null);
      setStatus({
        tone: "ok",
        message: `Loaded “${result.scheme.name}” — ${plural(
          result.kept,
          "colour",
        )}${result.ignored > 0 ? `, ${result.ignored} not recognised` : ""}.`,
      });
    } catch (error) {
      setStatus({ tone: "error", message: describe(error) });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex gap-2">
          {MODES.map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={mode === value ? "default" : "outline"}
              className="flex-1"
              onClick={() => theme.setTheme(value)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Editing the {mode} palette — the one you can see. Choosing the other
          switches the app to it, which also pins the theme; put it back on
          System under Customization.
        </p>
      </section>

      <Separator />

      {COLOR_GROUPS.map((group) => (
        <section key={group.id} className="space-y-1.5">
          <h3 className="text-sm font-medium">{group.label}</h3>
          <p className="text-xs text-muted-foreground">{group.hint}</p>

          <div className="divide-y divide-border rounded-[1.5px] border border-border">
            {group.tokens.map((token) => (
              <TokenRow
                key={token.key}
                meta={token}
                value={effectiveColor(scheme, mode, token.key)}
                isChanged={isOverridden(scheme, mode, token.key)}
                isOpen={openToken === token.key}
                onToggle={() =>
                  setOpenToken((current) =>
                    current === token.key ? null : token.key,
                  )
                }
                onChange={(value) => setColor(mode, token.key, value)}
                onReset={() => setColor(mode, token.key, null)}
                dragProps={preview.dragProps}
              />
            ))}
          </div>
        </section>
      ))}

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Scheme</h3>

        <div className="space-y-1.5">
          <Label htmlFor="scheme-name">Name</Label>
          <Input
            id="scheme-name"
            value={scheme.name}
            maxLength={60}
            spellCheck={false}
            onChange={(event) => rename(event.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={isBusy}
            onClick={() => void handleExport()}
          >
            <Download />
            Export…
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={isBusy}
            onClick={() => void handleImport()}
          >
            <Upload />
            Import…
          </Button>
        </div>

        {status && (
          <p
            className={cn(
              "flex items-start gap-1.5 text-xs break-all",
              status.tone === "ok" ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {status.tone === "ok" ? (
              <Check className="mt-px size-3.5 shrink-0" />
            ) : (
              <CircleAlert className="mt-px size-3.5 shrink-0" />
            )}
            {status.message}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          A scheme file carries both palettes and only the colours you actually
          changed — {changed === 0 ? "none so far" : `${changed} so far`}.
          Everything else is left to the stylesheet, which is what keeps an
          untouched Ringo looking exactly as it shipped, and what makes Reset a
          deletion rather than a second guess at the original.
        </p>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={changedHere === 0}
            onClick={() => {
              resetMode(mode);
              setOpenToken(null);
            }}
          >
            <RotateCcw className="size-3.5" />
            Reset {mode}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={isDefaultScheme(scheme)}
            onClick={() => {
              reset();
              setOpenToken(null);
              setStatus(null);
            }}
          >
            <RotateCcw className="size-3.5" />
            Reset both palettes
          </Button>
        </div>
      </section>
    </div>
  );
}

/** One token: a swatch and a name, expanding into the sliders that change it. */
function TokenRow({
  meta,
  value,
  isChanged,
  isOpen,
  onToggle,
  onChange,
  onReset,
  dragProps,
}: {
  meta: ColorTokenMeta;
  value: string;
  isChanged: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
  onReset: () => void;
  dragProps: ReturnType<typeof useLivePreview>["dragProps"];
}) {
  const color = parseColorOr(value);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2.5 p-2 text-left transition-colors hover:bg-muted/60"
      >
        <Swatch color={color} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-sm">{meta.label}</span>
            {isChanged && (
              // A plain titled span rather than a Tooltip: this sits inside
              // the row's own button, and the trigger would be a second
              // interactive element competing for the same press.
              <span
                title="Changed from the default"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {meta.description}
          </span>
        </span>
        <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {toHex(color)}
        </code>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <TokenEditor
          label={meta.label}
          value={value}
          isChanged={isChanged}
          onChange={onChange}
          onReset={onReset}
          dragProps={dragProps}
        />
      )}
    </div>
  );
}

/**
 * The four sliders for one colour, plus the two ways of typing it directly.
 *
 * Hue, saturation, and lightness are held in component state rather than
 * re-derived from the stored colour on every render, and that is not an
 * optimisation. HSL is not injective onto sRGB at the ends of its range: pure
 * black is `(0°, 0%, 0%)` no matter what hue produced it, so a round trip
 * through the stored hex would reset the hue slider to zero the instant the
 * lightness slider reached the bottom, and dragging back up would come out
 * grey. Keeping the three numbers means the drag you started is the drag you
 * finish.
 *
 * The stored value is still authoritative — when it changes to something this
 * editor did not write (Reset, or an import), the sliders re-seed from it.
 */
function TokenEditor({
  label,
  value,
  isChanged,
  onChange,
  onReset,
  dragProps,
}: {
  label: string;
  value: string;
  isChanged: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  dragProps: ReturnType<typeof useLivePreview>["dragProps"];
}) {
  const [state, setState] = useState(() => seed(value));
  const [draft, setDraft] = useState<string | null>(null);

  // Adjusted during render rather than in an effect, so the sliders never
  // paint against a colour that is no longer the stored one. See
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  if (state.source !== value) setState(seed(value));

  /** Moves one of the three components, keeping the other two exactly as set. */
  const adjust = (patch: Partial<Hsla>) => {
    const hsl = { ...state.hsl, ...patch };
    const next = toHex(hslToRgb(hsl));
    setState({ source: next, hsl });
    onChange(next);
  };

  /** Replaces the colour outright — the hex field and the native picker. */
  const commit = (next: string) => {
    setState(seed(next));
    onChange(next);
  };

  const { h, s, l, a } = state.hsl;
  const hex = toHex(hslToRgb(state.hsl));

  return (
    <div className="space-y-2 border-t border-border bg-muted/30 p-2.5">
      <div {...dragProps} className="space-y-0.5">
        <SliderRow
          label="Hue"
          value={h}
          min={0}
          max={360}
          step={1}
          display={`${Math.round(h)}°`}
          onChange={(next) => adjust({ h: next })}
        />
        <SliderRow
          label="Saturation"
          value={s}
          min={0}
          max={100}
          step={1}
          display={`${Math.round(s)}%`}
          onChange={(next) => adjust({ s: next })}
        />
        <SliderRow
          label="Lightness"
          value={l}
          min={0}
          max={100}
          step={1}
          display={`${Math.round(l)}%`}
          onChange={(next) => adjust({ l: next })}
        />
        {/* Not decoration: the stock dark palette draws its borders as white
            at 10% rather than as a grey, so a border edited without an opacity
            slider could never be put back the way it was. */}
        <SliderRow
          label="Opacity"
          value={a * 100}
          min={0}
          max={100}
          step={1}
          display={`${Math.round(a * 100)}%`}
          onChange={(next) => adjust({ a: next / 100 })}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour`}
          value={toOpaqueHex(hslToRgb(state.hsl))}
          onChange={(event) =>
            commit(toHex({ ...parseColorOr(event.target.value), a }))
          }
          className="size-7 shrink-0 cursor-pointer rounded-[1.5px] border-0 bg-transparent p-0"
        />
        <Input
          aria-label={`${label} as hex`}
          value={draft ?? hex}
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const parsed = parseColor(text);
            if (parsed) commit(toHex(parsed));
          }}
          // Dropped on blur so the field goes back to showing the colour that
          // is actually stored, rather than half-typed text that never took.
          onBlur={() => setDraft(null)}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          disabled={!isChanged}
          onClick={() => {
            setDraft(null);
            onReset();
          }}
        >
          <RotateCcw className="size-3" />
          Default
        </Button>
      </div>
    </div>
  );
}

function seed(source: string): { source: string; hsl: Hsla } {
  return { source, hsl: rgbToHsl(parseColorOr(source)) };
}

/** The colour itself, over a checkerboard so opacity is visible. */
function Swatch({ color }: { color: Rgba }) {
  return (
    <span
      style={{ background: CHECKERBOARD }}
      className="size-6 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-foreground/20"
    >
      <span
        style={{ backgroundColor: toRgbaCss(color) }}
        className={cn(
          "block size-full",
          // A near-white swatch on a white checker would vanish into it.
          isLight(color) && "ring-1 ring-foreground/10 ring-inset",
        )}
      />
    </span>
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
      <span className="w-[4.5rem] shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
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
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {display}
      </span>
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Whatever went wrong, as a sentence — IPC errors already carry one. */
function describe(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "That didn't work.";
}

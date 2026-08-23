/**
 * How the app itself is sized and spaced.
 *
 * Presentation state, so it lives in `localStorage` beside the theme and the
 * subtitle style rather than in `settings.json` — a size that reads well on a
 * laptop is wrong on a TV, and none of it belongs in the same file as an API
 * key. See {@link module:lib/subtitle-style} for the on-video half of the same
 * idea.
 *
 * Both values are applied as properties of the root element, which is what
 * lets a single write restyle every screen at once:
 *
 * * `font-size` on `<html>` is what `rem` is a multiple of, and Tailwind sizes
 *   nearly everything in `rem`, so scaling it scales text, padding, and the
 *   width of the sidebar together — a zoom rather than just bigger letters.
 * * `--transcript-font-size` is read by the transcript lines alone, because the
 *   text you are actually studying wants to be adjustable without inflating
 *   the chrome around it.
 */

export interface Appearance {
  /** Multiplier on the 16px root size: 1 is the browser default. */
  uiScale: number;
  /** Size of a transcript line, in CSS pixels. */
  transcriptFontSize: number;
}

export const UI_SCALE_RANGE = { min: 0.8, max: 1.5 } as const;
export const TRANSCRIPT_FONT_SIZE_RANGE = { min: 12, max: 32 } as const;

/** The `rem` basis every scale is a multiple of. */
const ROOT_FONT_PX = 16;

export const DEFAULT_APPEARANCE: Appearance = {
  uiScale: 1,
  // Matches the size the transcript was hard-coded to before this was
  // adjustable, so nobody's layout moves on upgrade.
  transcriptFontSize: 15,
};

const STORAGE_KEY = "ringo:appearance";

/** Custom property the transcript reads its size from. */
export const TRANSCRIPT_FONT_SIZE_VAR = "--transcript-font-size";

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Merges stored values over the defaults.
 *
 * As paranoid as the subtitle style's reviver, and for the same reason: this
 * is hand-editable JSON, and a `uiScale` of `0` would render an app with no
 * legible way to fix it.
 */
export function reviveAppearance(raw: unknown): Appearance {
  if (!raw || typeof raw !== "object") return DEFAULT_APPEARANCE;
  const stored = raw as Partial<Appearance>;
  return {
    uiScale: clampNumber(
      stored.uiScale,
      UI_SCALE_RANGE.min,
      UI_SCALE_RANGE.max,
      DEFAULT_APPEARANCE.uiScale,
    ),
    transcriptFontSize: clampNumber(
      stored.transcriptFontSize,
      TRANSCRIPT_FONT_SIZE_RANGE.min,
      TRANSCRIPT_FONT_SIZE_RANGE.max,
      DEFAULT_APPEARANCE.transcriptFontSize,
    ),
  };
}

export function getStoredAppearance(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? reviveAppearance(JSON.parse(raw)) : DEFAULT_APPEARANCE;
  } catch {
    // Malformed JSON, or storage disabled. Defaults are always usable.
    return DEFAULT_APPEARANCE;
  }
}

export function setStoredAppearance(appearance: Appearance): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.style.fontSize = `${(appearance.uiScale * ROOT_FONT_PX).toFixed(2)}px`;
  root.style.setProperty(
    TRANSCRIPT_FONT_SIZE_VAR,
    `${appearance.transcriptFontSize}px`,
  );
}

/**
 * The same logic as a source string, for the blocking script in the layout.
 *
 * Duplicated in plain JS for the same reason the theme's is: this module can't
 * run before hydration, and a UI that lays itself out at one size and then
 * jumps to another on every launch is worse than a frame of the wrong theme —
 * the whole window reflows.
 */
export function appearanceInitScript(): string {
  return `(function(){try{var a=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var r=document.documentElement;var s=Number(a.uiScale);if(s>=${UI_SCALE_RANGE.min}&&s<=${UI_SCALE_RANGE.max})r.style.fontSize=(s*${ROOT_FONT_PX})+"px";var t=Number(a.transcriptFontSize);if(t>=${TRANSCRIPT_FONT_SIZE_RANGE.min}&&t<=${TRANSCRIPT_FONT_SIZE_RANGE.max})r.style.setProperty("${TRANSCRIPT_FONT_SIZE_VAR}",t+"px");}catch(e){}})();`;
}

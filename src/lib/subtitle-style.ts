/**
 * How the on-video subtitles look and where they sit.
 *
 * Presentation state, so it lives in `localStorage` alongside the theme rather
 * than in `settings.json`, which is about what the pipeline does. It is
 * per-machine by nature: a size that reads well on a laptop is wrong on a TV,
 * and neither belongs in a file that also holds an API key.
 *
 * Positions are stored as **fractions of the video area**, not pixels. That is
 * what makes a block stay where the user put it when the window is resized or
 * fullscreen is toggled — the same drop point, proportionally.
 */

export type SubtitleTrackKey = "japanese" | "translation";

export interface Position {
  /** Horizontal centre of the block, 0 (left edge) to 1 (right edge). */
  x: number;
  /** Vertical centre of the block, 0 (top) to 1 (bottom). */
  y: number;
}

export interface SubtitleTrackStyle {
  enabled: boolean;
  /** Text size in CSS pixels. */
  fontSize: number;
  /** Any CSS colour; the picker writes hex. */
  color: string;
  /** Opacity of the box behind the text, 0 (none) to 1 (solid black). */
  background: number;
  /** Widest the block may grow, as a fraction of the video's width. */
  maxWidth: number;
  position: Position;
}

export interface SubtitleStyle {
  /** Master switch, toggled by the `c` key and the CC button. */
  enabled: boolean;
  japanese: SubtitleTrackStyle;
  translation: SubtitleTrackStyle;
}

export const FONT_SIZE_RANGE = { min: 12, max: 72 } as const;
export const MAX_WIDTH_RANGE = { min: 0.3, max: 1 } as const;

/**
 * Keep-out margin when dragging, as a fraction of each axis. A block dragged
 * to the very edge would be half off-screen, since positions are its centre.
 */
const EDGE_MARGIN = 0.04;

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  enabled: true,
  japanese: {
    enabled: true,
    fontSize: 30,
    color: "#ffffff",
    background: 0.55,
    maxWidth: 0.86,
    // Sitting where burned-in subtitles usually do, with the translation
    // directly beneath it.
    position: { x: 0.5, y: 0.83 },
  },
  translation: {
    enabled: true,
    fontSize: 19,
    // Dimmer than the Japanese line on purpose: the point is to read the
    // Japanese and glance down, not the other way round.
    color: "#d4d4d8",
    background: 0.45,
    maxWidth: 0.86,
    position: { x: 0.5, y: 0.93 },
  },
};

/** Presets offered as swatches, ordered light to dark. */
export const SUBTITLE_COLORS = [
  "#ffffff",
  "#f5f5f4",
  "#fde68a",
  "#facc15",
  "#86efac",
  "#7dd3fc",
  "#fca5a5",
  "#a1a1aa",
] as const;

const STORAGE_KEY = "ringo:subtitles";

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** Keeps a dragged block inside the frame. */
export function clampPosition(position: Position): Position {
  return {
    x: clampNumber(position.x, EDGE_MARGIN, 1 - EDGE_MARGIN, 0.5),
    y: clampNumber(position.y, EDGE_MARGIN, 1 - EDGE_MARGIN, 0.9),
  };
}

/**
 * Merges stored values over the defaults, field by field.
 *
 * Deliberately paranoid: this is hand-editable JSON in `localStorage`, and a
 * `fontSize` of `null` or a position of `{x: 40}` (pixels, from a future
 * mistake) would otherwise render the subtitles invisible with no way back
 * except clearing site data.
 */
function reviveTrack(
  raw: unknown,
  fallback: SubtitleTrackStyle,
): SubtitleTrackStyle {
  if (!raw || typeof raw !== "object") return fallback;
  const stored = raw as Partial<SubtitleTrackStyle>;
  const position =
    stored.position && typeof stored.position === "object"
      ? clampPosition({
          x: clampNumber(stored.position.x, 0, 1, fallback.position.x),
          y: clampNumber(stored.position.y, 0, 1, fallback.position.y),
        })
      : fallback.position;

  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : fallback.enabled,
    fontSize: clampNumber(
      stored.fontSize,
      FONT_SIZE_RANGE.min,
      FONT_SIZE_RANGE.max,
      fallback.fontSize,
    ),
    color:
      typeof stored.color === "string" && stored.color.trim()
        ? stored.color
        : fallback.color,
    background: clampNumber(stored.background, 0, 1, fallback.background),
    maxWidth: clampNumber(
      stored.maxWidth,
      MAX_WIDTH_RANGE.min,
      MAX_WIDTH_RANGE.max,
      fallback.maxWidth,
    ),
    position,
  };
}

export function getStoredSubtitleStyle(): SubtitleStyle {
  if (typeof window === "undefined") return DEFAULT_SUBTITLE_STYLE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SUBTITLE_STYLE;
    const stored = JSON.parse(raw) as Partial<SubtitleStyle>;
    return {
      enabled:
        typeof stored.enabled === "boolean"
          ? stored.enabled
          : DEFAULT_SUBTITLE_STYLE.enabled,
      japanese: reviveTrack(stored.japanese, DEFAULT_SUBTITLE_STYLE.japanese),
      translation: reviveTrack(stored.translation, DEFAULT_SUBTITLE_STYLE.translation),
    };
  } catch {
    // Malformed JSON, or storage disabled. Defaults are always usable.
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function setStoredSubtitleStyle(style: SubtitleStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}

/** `rgba(0, 0, 0, a)` for the box behind a subtitle line. */
export function backgroundColor(opacity: number): string {
  return `rgba(0, 0, 0, ${opacity.toFixed(2)})`;
}

/**
 * Outline for the text itself, so a line stays readable over a bright frame
 * even with the box turned all the way off.
 */
export const TEXT_SHADOW =
  "0 1px 2px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7), 0 0 1px rgba(0,0,0,1)";

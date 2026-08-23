/**
 * How the player screen is divided between the picture and the transcript.
 *
 * Presentation state, so it lives in `localStorage` beside the theme, the
 * interface scale, and the subtitle style rather than in `settings.json` —
 * see {@link module:lib/appearance} for the reasoning. A split that reads
 * well on a laptop is wrong on an ultrawide, and none of it belongs in the
 * same file as an API key.
 *
 * The width is kept in **rem**, not pixels, which is what makes it obey the
 * interface scale: `uiScale` sets the root font size, so raising it widens
 * the transcript in step with the text inside it. That was already true when
 * the width was the hard-coded `26rem` this defaults to, and Settings still
 * promises it.
 */

/** Which side of the video the transcript sits on. */
export type TranscriptSide = "left" | "right";

export interface PlayerLayout {
  side: TranscriptSide;
  /** False while the transcript is put away and the video has the window. */
  visible: boolean;
  /** Width of the transcript column, in rem. */
  width: number;
}

/**
 * How far the divider may be dragged, in rem.
 *
 * The floor is the point below which the panel stops being a transcript: the
 * search box, the source menu, and a line of Japanese with its translation
 * all have to fit, and — the reason a floor exists at all — the divider must
 * stay wide enough to grab, so a panel can never be squeezed to a size it
 * cannot be dragged back out of.
 */
export const TRANSCRIPT_WIDTH_RANGE = { min: 18, max: 56 } as const;

/**
 * How much of the window the video keeps no matter how wide the transcript
 * is dragged. Enforced against the live container width rather than the
 * stored number, so the same setting behaves on a small window.
 */
export const MIN_VIDEO_WIDTH = 22;

export const DEFAULT_LAYOUT: PlayerLayout = {
  side: "right",
  visible: true,
  // The width the sidebar was hard-coded to before it could be dragged, so
  // nobody's layout moves on upgrade.
  width: 26,
};

const STORAGE_KEY = "ringo:layout";

/** The `rem` basis, read live because `uiScale` changes it. */
export function rootFontSizePx(): number {
  if (typeof window === "undefined") return 16;
  const size = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  );
  return Number.isFinite(size) && size > 0 ? size : 16;
}

export function clampTranscriptWidth(
  width: number,
  max: number = TRANSCRIPT_WIDTH_RANGE.max,
): number {
  if (!Number.isFinite(width)) return DEFAULT_LAYOUT.width;
  // The floor wins over the ceiling: on a window too narrow for both minimums
  // the transcript keeps its usable width and the video gives way, because a
  // panel narrower than its own divider cannot be dragged back.
  return Math.max(TRANSCRIPT_WIDTH_RANGE.min, Math.min(width, max));
}

/**
 * The width the transcript column is actually given.
 *
 * A CSS expression rather than a number because the second term is
 * container-relative: `100%` is the row holding the video and the panel, so
 * shrinking the window narrows the transcript instead of crushing the picture,
 * and widening it hands the space back — all without a resize listener. The
 * stored value is already clamped to {@link TRANSCRIPT_WIDTH_RANGE}, so only
 * the floor is repeated here.
 */
export function transcriptWidthCss(width: number): string {
  return `max(${TRANSCRIPT_WIDTH_RANGE.min}rem, min(${width}rem, 100% - ${MIN_VIDEO_WIDTH}rem))`;
}

/**
 * Merges stored values over the defaults.
 *
 * As paranoid as the appearance and subtitle revivers, and for the same
 * reason: this is hand-editable JSON, and a `width` of `0` or a `side` of
 * `"middle"` would render a player with no legible way to fix it.
 */
export function reviveLayout(raw: unknown): PlayerLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
  const stored = raw as Partial<PlayerLayout>;
  return {
    side: stored.side === "left" || stored.side === "right" ? stored.side : DEFAULT_LAYOUT.side,
    visible: typeof stored.visible === "boolean" ? stored.visible : DEFAULT_LAYOUT.visible,
    width:
      typeof stored.width === "number" && Number.isFinite(stored.width)
        ? clampTranscriptWidth(stored.width)
        : DEFAULT_LAYOUT.width,
  };
}

export function getStoredLayout(): PlayerLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? reviveLayout(JSON.parse(raw)) : DEFAULT_LAYOUT;
  } catch {
    // Malformed JSON, or storage disabled. Defaults are always usable.
    return DEFAULT_LAYOUT;
  }
}

export function setStoredLayout(layout: PlayerLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage full or unavailable: the layout still applies for this session.
  }
}

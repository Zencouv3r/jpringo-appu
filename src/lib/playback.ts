/**
 * What the arrow keys do during playback.
 *
 * Presentation state like the theme and the split, so it lives in
 * `localStorage` rather than in `settings.json` — see
 * {@link module:lib/appearance} for the reasoning. It is also the one keyboard
 * shortcut in the app with two defensible meanings, which is why it is a
 * setting at all rather than a decision made once here.
 *
 * The default is stepping between lines. A fixed rewind either clips the start
 * of a line or overshoots into the one before it, and the transcript is the
 * only thing that knows where a line begins — the same argument the arrows
 * beside the subtitle are built on. Seconds are there for the two cases lines
 * cannot serve: a file with no transcript yet, and skipping past something
 * long rather than reading through it.
 */

/** Which of the two things `←` and `→` do. */
export type ArrowKeyAction = "line" | "seek";

export interface PlaybackKeys {
  arrows: ArrowKeyAction;
  /** How far one press moves in `seek` mode, in seconds. */
  seekSeconds: number;
}

/**
 * How far a single press may be set to jump.
 *
 * The floor is where the arrows started out before this was adjustable, so
 * nobody who liked the old five-second nudge loses it; the ceiling is about
 * where a jump stops being a correction and becomes navigation, which the
 * scrubber does better.
 */
export const SEEK_SECONDS_RANGE = { min: 5, max: 30 } as const;

/** Nobody is choosing between 17 and 18 seconds. */
export const SEEK_SECONDS_STEP = 5;

export const DEFAULT_PLAYBACK_KEYS: PlaybackKeys = {
  arrows: "line",
  seekSeconds: 10,
};

const STORAGE_KEY = "ringo:playback";

export function clampSeekSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_PLAYBACK_KEYS.seekSeconds;
  const snapped = Math.round(seconds / SEEK_SECONDS_STEP) * SEEK_SECONDS_STEP;
  return Math.min(SEEK_SECONDS_RANGE.max, Math.max(SEEK_SECONDS_RANGE.min, snapped));
}

/**
 * Merges stored values over the defaults.
 *
 * As paranoid as the appearance and layout revivers, and for the same reason:
 * this is hand-editable JSON, and a `seekSeconds` of `0` would give the player
 * two keys that look broken.
 */
export function revivePlaybackKeys(raw: unknown): PlaybackKeys {
  if (!raw || typeof raw !== "object") return DEFAULT_PLAYBACK_KEYS;
  const stored = raw as Partial<PlaybackKeys>;
  return {
    arrows:
      stored.arrows === "line" || stored.arrows === "seek"
        ? stored.arrows
        : DEFAULT_PLAYBACK_KEYS.arrows,
    seekSeconds:
      typeof stored.seekSeconds === "number"
        ? clampSeekSeconds(stored.seekSeconds)
        : DEFAULT_PLAYBACK_KEYS.seekSeconds,
  };
}

export function getStoredPlaybackKeys(): PlaybackKeys {
  if (typeof window === "undefined") return DEFAULT_PLAYBACK_KEYS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? revivePlaybackKeys(JSON.parse(raw)) : DEFAULT_PLAYBACK_KEYS;
  } catch {
    // Malformed JSON, or storage disabled. Defaults are always usable.
    return DEFAULT_PLAYBACK_KEYS;
  }
}

export function setStoredPlaybackKeys(keys: PlaybackKeys): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Storage full or unavailable: the choice still applies for this session.
  }
}

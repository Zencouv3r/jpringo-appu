"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_PLAYBACK_KEYS,
  clampSeekSeconds,
  getStoredPlaybackKeys,
  setStoredPlaybackKeys,
  type ArrowKeyAction,
  type PlaybackKeys,
} from "@/lib/playback";

/**
 * What the arrow keys do, kept in sync with `localStorage`.
 *
 * Mirrors {@link usePlayerLayout}: the first render uses the defaults because
 * the static build has no `window`, and the stored choice is read on mount.
 * No blocking script — nothing about this is visible until a key is pressed,
 * so there is nothing to flash.
 */
export function usePlaybackKeys() {
  const [keys, setKeys] = useState<PlaybackKeys>(DEFAULT_PLAYBACK_KEYS);

  // Wrapped in a resolved microtask rather than called in the effect body,
  // matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => setKeys(getStoredPlaybackKeys()));
  }, []);

  /** Applies a change and persists it, so nothing is only in React state. */
  const commit = useCallback((patch: Partial<PlaybackKeys>) => {
    setKeys((current) => {
      const next = { ...current, ...patch };
      setStoredPlaybackKeys(next);
      return next;
    });
  }, []);

  const setArrows = useCallback(
    (arrows: ArrowKeyAction) => commit({ arrows }),
    [commit],
  );

  const setSeekSeconds = useCallback(
    (seconds: number) => commit({ seekSeconds: clampSeekSeconds(seconds) }),
    [commit],
  );

  return { keys, setArrows, setSeekSeconds };
}

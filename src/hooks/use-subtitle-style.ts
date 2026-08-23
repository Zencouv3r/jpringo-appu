"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_SUBTITLE_STYLE,
  clampPosition,
  getStoredSubtitleStyle,
  setStoredSubtitleStyle,
  type Position,
  type SubtitleStyle,
  type SubtitleTrackKey,
  type SubtitleTrackStyle,
} from "@/lib/subtitle-style";

/**
 * Subtitle appearance, kept in sync with `localStorage`.
 *
 * Mirrors {@link useTheme}: the first render uses the defaults because the
 * static build has no `window`, and the stored values are read on mount. A
 * subtitle that appears at its default size for one frame is not worth a
 * blocking script the way a flash of the light theme is.
 */
export function useSubtitleStyle() {
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);

  // Wrapped in a resolved microtask rather than called in the effect body,
  // matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => setStyle(getStoredSubtitleStyle()));
  }, []);

  /** Applies a change and persists it, so nothing is only in React state. */
  const commit = useCallback((next: SubtitleStyle) => {
    setStyle(next);
    setStoredSubtitleStyle(next);
  }, []);

  /** Patches one track's style — size, colour, background, width, enabled. */
  const update = useCallback(
    (track: SubtitleTrackKey, patch: Partial<SubtitleTrackStyle>) => {
      setStyle((current) => {
        const next = { ...current, [track]: { ...current[track], ...patch } };
        setStoredSubtitleStyle(next);
        return next;
      });
    },
    [],
  );

  /**
   * Moves a block. Called for every pointer move during a drag, so it writes
   * through `setStyle`'s updater rather than closing over the current style —
   * a stale copy would make the block snap back mid-drag.
   */
  const move = useCallback((track: SubtitleTrackKey, position: Position) => {
    setStyle((current) => {
      const next = {
        ...current,
        [track]: { ...current[track], position: clampPosition(position) },
      };
      setStoredSubtitleStyle(next);
      return next;
    });
  }, []);

  const toggle = useCallback(() => {
    setStyle((current) => {
      const next = { ...current, enabled: !current.enabled };
      setStoredSubtitleStyle(next);
      return next;
    });
  }, []);

  /** Puts both blocks back where they started, leaving colours and sizes alone. */
  const resetPositions = useCallback(() => {
    setStyle((current) => {
      const next: SubtitleStyle = {
        ...current,
        japanese: {
          ...current.japanese,
          position: DEFAULT_SUBTITLE_STYLE.japanese.position,
        },
        translation: {
          ...current.translation,
          position: DEFAULT_SUBTITLE_STYLE.translation.position,
        },
      };
      setStoredSubtitleStyle(next);
      return next;
    });
  }, []);

  const reset = useCallback(
    () => commit(DEFAULT_SUBTITLE_STYLE),
    [commit],
  );

  return { style, update, move, toggle, resetPositions, reset };
}

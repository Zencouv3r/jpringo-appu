"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_LAYOUT,
  clampTranscriptWidth,
  getStoredLayout,
  setStoredLayout,
  type PlayerLayout,
  type TranscriptSide,
} from "@/lib/layout";

/**
 * Where the transcript sits, how wide it is, and whether it is there at all.
 *
 * Mirrors {@link useSubtitleStyle}: the first render uses the defaults because
 * the static build has no `window`, and the stored layout is read on mount.
 * No blocking script the way the theme and the interface scale get one — this
 * only applies inside an open video, which is several interactions after the
 * first paint, so there is nothing to flash.
 */
export function usePlayerLayout() {
  const [layout, setLayout] = useState<PlayerLayout>(DEFAULT_LAYOUT);

  // Wrapped in a resolved microtask rather than called in the effect body,
  // matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => setLayout(getStoredLayout()));
  }, []);

  /** Applies a change and persists it, so nothing is only in React state. */
  const commit = useCallback((patch: Partial<PlayerLayout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      setStoredLayout(next);
      return next;
    });
  }, []);

  /**
   * Called for every pointer move during a drag, so it goes through the
   * updater rather than closing over the current width — a stale copy would
   * make the divider snap back mid-drag.
   *
   * The caller passes the ceiling it measured from the live container, since
   * only it knows how much room the video has left.
   */
  const resize = useCallback(
    (width: number, max?: number) => commit({ width: clampTranscriptWidth(width, max) }),
    [commit],
  );

  const resetWidth = useCallback(() => commit({ width: DEFAULT_LAYOUT.width }), [commit]);

  const setSide = useCallback((side: TranscriptSide) => commit({ side }), [commit]);

  const swapSide = useCallback(
    () => setLayout((current) => {
      const next: PlayerLayout = {
        ...current,
        side: current.side === "right" ? "left" : "right",
      };
      setStoredLayout(next);
      return next;
    }),
    [],
  );

  const toggleVisible = useCallback(
    () => setLayout((current) => {
      const next = { ...current, visible: !current.visible };
      setStoredLayout(next);
      return next;
    }),
    [],
  );

  const show = useCallback(() => commit({ visible: true }), [commit]);
  const hide = useCallback(() => commit({ visible: false }), [commit]);

  return { layout, resize, resetWidth, setSide, swapSide, toggleVisible, show, hide };
}

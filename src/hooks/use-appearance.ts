"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  getStoredAppearance,
  setStoredAppearance,
  type Appearance,
} from "@/lib/appearance";

/**
 * Interface size and transcript size, kept in sync with `localStorage`.
 *
 * Mirrors {@link useTheme}: a blocking script in the root layout has already
 * applied the stored values to `<html>` before this runs, so the job here is
 * only to react to changes made afterwards. The first render uses the defaults
 * because the static build has no `window`.
 */
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);

  // Wrapped in a resolved microtask rather than called in the effect body,
  // matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => {
      const stored = getStoredAppearance();
      setAppearance(stored);
      // Re-applied rather than trusted to the layout's script: that script is
      // the one that beats first paint, but if it ever fails to run the app
      // would silently ignore the setting until something else changed it.
      applyAppearance(stored);
    });
  }, []);

  const commit = useCallback((next: Appearance) => {
    setAppearance(next);
    setStoredAppearance(next);
    applyAppearance(next);
  }, []);

  /** Patches one field, so callers don't reassemble the whole object. */
  const update = useCallback((patch: Partial<Appearance>) => {
    setAppearance((current) => {
      const next = { ...current, ...patch };
      setStoredAppearance(next);
      applyAppearance(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => commit(DEFAULT_APPEARANCE), [commit]);

  return { appearance, update, reset };
}

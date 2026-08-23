"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import {
  DEFAULT_COLOR_SCHEME,
  applyColorScheme,
  getStoredColorScheme,
  setStoredColorScheme,
  withColor,
  type ColorMode,
  type ColorScheme,
} from "@/lib/color-scheme";

/**
 * Before paint in the browser, and a no-op during the static prerender.
 *
 * The palette has to land in the same frame as the `dark` class it belongs
 * with. `useTheme` toggles that class synchronously the moment the theme
 * changes, so an effect that waited for the browser to paint would show one
 * frame of the *other* mode's overrides sitting on top of the new mode's
 * stylesheet — a light-mode background under dark-mode text, which for a
 * partly-recoloured scheme is a genuinely broken-looking combination rather
 * than merely a late one.
 *
 * `useLayoutEffect` warns when React renders on the server, and this app is
 * statically exported, so the choice is made once at module scope. There is
 * nothing to lay out during a prerender anyway.
 */
const useApplyEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The interface palette, kept in sync with `localStorage` and the live theme.
 *
 * Mirrors {@link useAppearance}: a blocking script in the root layout has
 * already written the stored overrides onto `<html>` before this runs, so the
 * job here is to react to what happens afterwards — an edit, an import, or the
 * theme flipping underneath.
 *
 * That last one is why `mode` is a parameter rather than something read once.
 * A scheme carries a light palette *and* a dark one, and only the one matching
 * the resolved theme is on the element at any moment; when the OS switches at
 * sunset, the other palette has to be swapped in. Passing the resolved theme
 * in from {@link useTheme} keeps that a plain dependency instead of a second
 * subscription to the same media query.
 */
export function useColorScheme(mode: ColorMode) {
  const [scheme, setScheme] = useState<ColorScheme>(DEFAULT_COLOR_SCHEME);
  // Nothing is written to the document until the stored scheme has been read.
  // Without this the first paint would be re-applied from the defaults, which
  // would *undo* what the layout's blocking script just did — a flash of the
  // stock palette on every launch, which is the one thing that script exists
  // to prevent.
  const [isLoaded, setIsLoaded] = useState(false);

  // Wrapped in a resolved microtask rather than called in the effect body,
  // matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => {
      setScheme(getStoredColorScheme());
      setIsLoaded(true);
    });
  }, []);

  // Re-applied rather than trusted to the layout's script for the reason
  // `useAppearance` gives: that script is the one that beats first paint, but
  // if it ever fails to run the app would silently ignore the scheme.
  useApplyEffect(() => {
    if (isLoaded) applyColorScheme(scheme, mode);
  }, [isLoaded, scheme, mode]);

  /** Applies a whole scheme and persists it — used by reset and by import. */
  const replace = useCallback(
    (next: ColorScheme) => {
      setScheme(next);
      setStoredColorScheme(next);
      applyColorScheme(next, mode);
    },
    [mode],
  );

  /**
   * Sets one token in one palette, or clears it back to the stylesheet.
   *
   * Written through the updater rather than by closing over `scheme`, because
   * this is called for every frame of a slider drag and a stale copy would
   * make the colour snap back mid-drag — the same reason the subtitle style's
   * `move` is written that way.
   */
  const setColor = useCallback(
    (target: ColorMode, token: string, value: string | null) => {
      setScheme((current) => {
        const next = withColor(current, target, token, value);
        setStoredColorScheme(next);
        // Only the palette currently on screen needs writing; editing the
        // other one takes effect when the theme next resolves to it.
        if (target === mode) applyColorScheme(next, mode);
        return next;
      });
    },
    [mode],
  );

  const rename = useCallback((name: string) => {
    setScheme((current) => {
      const next = { ...current, name };
      setStoredColorScheme(next);
      return next;
    });
  }, []);

  /** Puts one palette back to stock, leaving the other one alone. */
  const resetMode = useCallback(
    (target: ColorMode) => {
      setScheme((current) => {
        const next = { ...current, [target]: {} };
        setStoredColorScheme(next);
        if (target === mode) applyColorScheme(next, mode);
        return next;
      });
    },
    [mode],
  );

  const reset = useCallback(
    () => replace(DEFAULT_COLOR_SCHEME),
    [replace],
  );

  return { scheme, mode, setColor, rename, resetMode, reset, replace };
}

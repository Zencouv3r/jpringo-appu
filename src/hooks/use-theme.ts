"use client";

import { useCallback, useEffect, useState } from "react";

import {
  applyResolvedTheme,
  getStoredTheme,
  resolveTheme,
  setStoredTheme,
  type Theme,
} from "@/lib/theme";

/**
 * Theme state, kept in sync with `localStorage` and the OS preference.
 *
 * The `<html>` class is also set by a blocking script in the root layout
 * before this hook ever runs, so there is no flash on load — this hook's job
 * is purely to react to changes made *after* that: the user picking a theme,
 * or the OS switching dark mode while `"system"` is selected.
 */
export function useTheme() {
  // The stored preference starts as "system" during SSR/the initial static
  // render (window isn't available), matching what the blocking script would
  // have already applied — see getStoredTheme's fallback.
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Reads localStorage, which the build-time static render couldn't see.
  // Wrapped in a resolved microtask rather than called directly in the effect
  // body, matching the pattern used elsewhere in this codebase for the same
  // "load on mount" shape.
  useEffect(() => {
    void Promise.resolve().then(() => {
      const stored = getStoredTheme();
      const resolvedTheme = resolveTheme(stored);
      setThemeState(stored);
      setResolved(resolvedTheme);
      // Re-applied rather than trusted to the layout's script, matching
      // `useAppearance` and `useColorScheme`. That script is the one that
      // beats first paint; if it ever fails to run, this is what keeps the
      // class on `<html>` agreeing with the palette `useColorScheme` is about
      // to write against it.
      applyResolvedTheme(resolvedTheme);
    });
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setStoredTheme(next);
    const nextResolved = resolveTheme(next);
    setResolved(nextResolved);
    applyResolvedTheme(nextResolved);
  }, []);

  // While following the OS, react live to it changing — otherwise switching
  // Windows' theme wouldn't be reflected until the app restarts.
  useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const nextResolved = query.matches ? "dark" : "light";
      setResolved(nextResolved);
      applyResolvedTheme(nextResolved);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, resolvedTheme: resolved, setTheme };
}

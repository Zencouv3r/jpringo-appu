/**
 * Theme resolution.
 *
 * `"system"` is the default and tracks the OS preference live; `"light"`/
 * `"dark"` are explicit overrides. The actual switch is a single class on
 * `<html>` — `globals.css` already declares `@custom-variant dark (&:is(.dark
 * *))`, so every existing `dark:` utility in the app picks this up for free.
 *
 * The blocking inline script in `app/layout.tsx` duplicates the read-and-apply
 * logic here in plain JS. That duplication is deliberate: this module can't
 * run before hydration, and without something running before first paint, a
 * dark-mode user sees a flash of the light theme on every launch.
 */

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "ringo:theme";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : "system";
}

export function setStoredTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolves `"system"` to the OS preference; `light`/`dark` pass through. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

export function applyResolvedTheme(resolved: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * The exact logic the blocking `<head>` script runs, as a source string.
 *
 * Kept here as a single source of truth and stringified into the script tag,
 * rather than hand-duplicated as a JS literal in the layout file, so the two
 * can't drift out of sync with each other or with {@link getStoredTheme} /
 * {@link resolveTheme} above.
 */
export function themeInitScript(): string {
  return `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var d=t==="dark"||((t!=="light")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
}

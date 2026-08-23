/**
 * The colour of every part of the interface.
 *
 * `globals.css` declares the palette as custom properties on `:root` and
 * `.dark`, and every Tailwind colour utility in the app resolves through them.
 * A colour scheme here is nothing more than a set of **overrides** on those
 * properties, written inline onto `<html>` — the highest-specificity place
 * there is, so one write restyles every screen at once.
 *
 * Overrides, not a full palette, and that distinction carries the whole
 * design:
 *
 * * A token the user has never touched is not stored, not written, and not
 *   converted. It renders from the literal in the stylesheet, so the stock
 *   scheme is *identical* to no scheme at all rather than a re-derivation of
 *   it that happens to look close. Nobody's app changes colour because this
 *   screen was added.
 * * Resetting a token is a deletion, so it can never drift from whatever the
 *   stylesheet says next.
 * * An exported file is small and readable — the handful of things somebody
 *   actually changed.
 *
 * Both palettes travel together. Light and dark are two different sets of the
 * same tokens, and a scheme that carried only the one in use would silently
 * throw the other away every time the OS switched at sunset.
 *
 * Stored in `localStorage` beside the theme and the subtitle style, for the
 * reason given in {@link module:lib/appearance}: it is per-machine
 * presentation state, and it does not belong in the same file as an API key.
 */

import { parseColor } from "@/lib/color";

/** The two palettes a scheme carries, matching `:root` and `.dark`. */
export type ColorMode = "light" | "dark";

/**
 * One editable custom property.
 *
 * The key is the property name without its dashes: `background` is
 * `--background`. Descriptions name the places a token is actually used, not
 * the abstract role it plays — "the transcript line being spoken" is
 * findable, "accent" is not.
 */
export interface ColorTokenMeta {
  key: string;
  label: string;
  description: string;
}

export interface ColorTokenGroup {
  id: string;
  label: string;
  hint: string;
  tokens: ColorTokenMeta[];
}

/**
 * Every token the editor offers, grouped the way somebody looks for them.
 *
 * `--chart-1…5` and the `--sidebar-*` family are declared in `globals.css` but
 * are not referenced anywhere in this app — shadcn ships them for components
 * Ringo does not use. They are deliberately left out: a picker that changes
 * nothing visible is worse than a shorter list. If a chart or a sidebar ever
 * lands, its tokens belong here.
 */
export const COLOR_GROUPS: ColorTokenGroup[] = [
  {
    id: "surfaces",
    label: "Surfaces",
    hint: "The planes the app is built out of, back to front.",
    tokens: [
      {
        key: "background",
        label: "Window",
        description: "Behind everything — the library, the transcript, the frame around the picture.",
      },
      {
        key: "card",
        label: "Cards",
        description: "Raised blocks: the recent-file tiles and the dictionary's entries.",
      },
      {
        key: "popover",
        label: "Menus and dialogs",
        description: "This dialog, the CC menu, tooltips, and every dropdown.",
      },
      {
        key: "muted",
        label: "Quiet fill",
        description: "Badges, slider tracks, and the panels behind small print.",
      },
      {
        key: "secondary",
        label: "Secondary buttons",
        description: "The quieter of the two filled button styles.",
      },
      {
        key: "accent",
        label: "Highlight",
        description: "Hover, and the transcript line currently being spoken.",
      },
    ],
  },
  {
    id: "text",
    label: "Text",
    hint: "Each surface names the ink that goes on it, so contrast survives a recolour.",
    tokens: [
      {
        key: "foreground",
        label: "Ordinary text",
        description: "Everything on the window background, including the transcript itself.",
      },
      {
        key: "muted-foreground",
        label: "Secondary text",
        description: "Readings, translations, hints, and timestamps.",
      },
      { key: "card-foreground", label: "On cards", description: "Text inside a raised block." },
      {
        key: "popover-foreground",
        label: "In menus",
        description: "Text inside a dialog, a dropdown, or a tooltip.",
      },
      {
        key: "primary-foreground",
        label: "On primary buttons",
        description: "The label on Transcribe and Explain.",
      },
      {
        key: "secondary-foreground",
        label: "On secondary buttons",
        description: "The label on the quieter filled buttons and badges.",
      },
      {
        key: "accent-foreground",
        label: "On highlights",
        description: "Text over a hovered row or the active transcript line.",
      },
    ],
  },
  {
    id: "actions",
    label: "Accents",
    hint: "The few colours that are meant to be noticed.",
    tokens: [
      {
        key: "primary",
        label: "Primary",
        description: "Filled buttons, the seek bar, slider fills, and the bar beside the active line.",
      },
      {
        key: "destructive",
        label: "Errors",
        description: "Failure messages and the buttons that throw something away.",
      },
      {
        key: "ring",
        label: "Focus ring",
        description: "The outline around whatever the keyboard is on.",
      },
    ],
  },
  {
    id: "lines",
    label: "Lines",
    hint: "Everything drawn one pixel wide.",
    tokens: [
      {
        key: "border",
        label: "Borders",
        description: "Every dividing line, including the seam beside the transcript.",
      },
      {
        key: "input",
        label: "Field outlines",
        description: "The edges of text fields, switches, and outline buttons.",
      },
    ],
  },
];

/** Flat token order, for iteration and for the blocking init script. */
export const COLOR_TOKENS: string[] = COLOR_GROUPS.flatMap((group) =>
  group.tokens.map((token) => token.key),
);

const TOKEN_SET = new Set(COLOR_TOKENS);

/**
 * The stylesheet's own values, verbatim.
 *
 * Kept as the exact OKLCh strings from `globals.css` rather than converted to
 * hex, because these are what an unedited token *renders as* — the editor only
 * ever reads them, to seed a slider or to draw the swatch beside a token
 * nobody has changed. Edit these together with `globals.css`; they are a
 * mirror of it in the same way `types.ts` mirrors `model.rs`.
 */
export const STOCK_PALETTE: Record<ColorMode, Record<string, string>> = {
  light: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.145 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    secondary: "oklch(0.97 0 0)",
    "secondary-foreground": "oklch(0.205 0 0)",
    muted: "oklch(0.97 0 0)",
    "muted-foreground": "oklch(0.556 0 0)",
    accent: "oklch(0.97 0 0)",
    "accent-foreground": "oklch(0.205 0 0)",
    destructive: "oklch(0.577 0.245 27.325)",
    border: "oklch(0.922 0 0)",
    input: "oklch(0.922 0 0)",
    ring: "oklch(0.708 0 0)",
  },
  dark: {
    background: "oklch(0.145 0 0)",
    foreground: "oklch(0.985 0 0)",
    card: "oklch(0.205 0 0)",
    "card-foreground": "oklch(0.985 0 0)",
    popover: "oklch(0.205 0 0)",
    "popover-foreground": "oklch(0.985 0 0)",
    primary: "oklch(0.922 0 0)",
    "primary-foreground": "oklch(0.205 0 0)",
    secondary: "oklch(0.269 0 0)",
    "secondary-foreground": "oklch(0.985 0 0)",
    muted: "oklch(0.269 0 0)",
    "muted-foreground": "oklch(0.708 0 0)",
    accent: "oklch(0.269 0 0)",
    "accent-foreground": "oklch(0.985 0 0)",
    destructive: "oklch(0.704 0.191 22.216)",
    border: "oklch(1 0 0 / 10%)",
    input: "oklch(1 0 0 / 15%)",
    ring: "oklch(0.556 0 0)",
  },
};

/** A scheme's overrides for one mode. Absent keys mean "leave the stylesheet alone". */
export type Palette = Partial<Record<string, string>>;

export interface ColorScheme {
  /** Shown in the editor and written into an exported file. */
  name: string;
  light: Palette;
  dark: Palette;
}

/** No overrides at all: the app exactly as it ships. */
export const DEFAULT_COLOR_SCHEME: ColorScheme = {
  name: "Ringo",
  light: {},
  dark: {},
};

const STORAGE_KEY = "ringo:colors";

/** Longest a scheme name may be, so a hand-edited file can't break the header. */
const MAX_NAME_LENGTH = 60;

// ---------------------------------------------------------------------------
// Reading a scheme
// ---------------------------------------------------------------------------

/** What a token renders as right now: the override if there is one, else stock. */
export function effectiveColor(
  scheme: ColorScheme,
  mode: ColorMode,
  token: string,
): string {
  return scheme[mode][token] ?? STOCK_PALETTE[mode][token] ?? "#000000";
}

/** Whether this token has been changed away from what the stylesheet says. */
export function isOverridden(
  scheme: ColorScheme,
  mode: ColorMode,
  token: string,
): boolean {
  return scheme[mode][token] !== undefined;
}

/** How many tokens the scheme changes, across both palettes. */
export function overrideCount(scheme: ColorScheme): number {
  return Object.keys(scheme.light).length + Object.keys(scheme.dark).length;
}

export function isDefaultScheme(scheme: ColorScheme): boolean {
  return overrideCount(scheme) === 0;
}

// ---------------------------------------------------------------------------
// Writing a scheme
// ---------------------------------------------------------------------------

/** Sets one token, or clears it back to the stylesheet when `value` is null. */
export function withColor(
  scheme: ColorScheme,
  mode: ColorMode,
  token: string,
  value: string | null,
): ColorScheme {
  const palette = { ...scheme[mode] };
  if (value === null) delete palette[token];
  else palette[token] = value;
  return { ...scheme, [mode]: palette };
}

/**
 * Applies a scheme to the document.
 *
 * Every token is visited, not just the overridden ones: a token that has just
 * been reset needs its inline property *removed*, and skipping it would leave
 * the old value stuck on `<html>` where nothing but a reload could shift it.
 */
export function applyColorScheme(scheme: ColorScheme, mode: ColorMode): void {
  const root = document.documentElement;
  const palette = scheme[mode];
  for (const token of COLOR_TOKENS) {
    const value = palette[token];
    if (value) root.style.setProperty(`--${token}`, value);
    else root.style.removeProperty(`--${token}`);
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function revivePalette(raw: unknown): Palette {
  if (!raw || typeof raw !== "object") return {};
  const palette: Palette = {};
  for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
    // Two filters, and both matter. An unknown token would be written to
    // `<html>` and never cleaned up by `applyColorScheme`, which only walks
    // the tokens it knows; an unparseable value would be handed to a slider
    // that has no idea what to do with it.
    if (!TOKEN_SET.has(token)) continue;
    if (typeof value !== "string" || !parseColor(value)) continue;
    palette[token] = value.trim();
  }
  return palette;
}

function reviveName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.trim().slice(0, MAX_NAME_LENGTH);
  return name || fallback;
}

/**
 * Merges stored values over the defaults.
 *
 * As paranoid as the subtitle style's reviver, and for a sharper version of
 * the same reason: this is hand-editable JSON, and a `background` of
 * `"transparent"` would render an app with no legible way to reach the button
 * that puts it back.
 */
export function reviveColorScheme(raw: unknown): ColorScheme {
  if (!raw || typeof raw !== "object") return DEFAULT_COLOR_SCHEME;
  const stored = raw as Partial<ColorScheme>;
  return {
    name: reviveName(stored.name, DEFAULT_COLOR_SCHEME.name),
    light: revivePalette(stored.light),
    dark: revivePalette(stored.dark),
  };
}

export function getStoredColorScheme(): ColorScheme {
  if (typeof window === "undefined") return DEFAULT_COLOR_SCHEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? reviveColorScheme(JSON.parse(raw)) : DEFAULT_COLOR_SCHEME;
  } catch {
    // Malformed JSON, or storage disabled. The stock palette always works.
    return DEFAULT_COLOR_SCHEME;
  }
}

export function setStoredColorScheme(scheme: ColorScheme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme));
  } catch {
    // Storage full or unavailable: the scheme still applies for this session.
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const FILE_KIND = "ringo-color-scheme";
const FILE_VERSION = 1;

/** Extension offered by both the save and the open dialog. */
export const SCHEME_FILE_EXTENSION = "json";

/** A scheme as a file: the same shape, wrapped in something self-describing. */
export function serializeColorScheme(scheme: ColorScheme): string {
  return `${JSON.stringify(
    {
      kind: FILE_KIND,
      version: FILE_VERSION,
      name: scheme.name,
      light: scheme.light,
      dark: scheme.dark,
    },
    null,
    2,
  )}\n`;
}

/** A filename that survives a scheme called `My / Theme`. */
export function schemeFileName(scheme: ColorScheme): string {
  const stem = scheme.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "ringo-colours";
  return `${stem}.${SCHEME_FILE_EXTENSION}`;
}

export type ImportResult =
  | { ok: true; scheme: ColorScheme; kept: number; ignored: number }
  | { ok: false; message: string };

/**
 * Reads a scheme file back.
 *
 * Never throws and never partially applies: either a whole scheme comes out or
 * a sentence explaining why not. Entries that name a token this build doesn't
 * have — a file from a newer version, or a typo — are counted rather than
 * treated as failure, and the count is reported, because dropping four of
 * eighteen tokens in silence is how somebody ends up wondering why half the
 * scheme "didn't work".
 */
export function parseColorSchemeFile(contents: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { ok: false, message: "That file isn't JSON." };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "That file doesn't hold a colour scheme." };
  }

  const file = raw as Record<string, unknown>;
  if (typeof file.kind === "string" && file.kind !== FILE_KIND) {
    return { ok: false, message: "That's a JSON file, but not a Ringo colour scheme." };
  }
  if (!file.light && !file.dark) {
    return {
      ok: false,
      message: "That scheme has no colours in it — expected a “light” or “dark” block.",
    };
  }

  const offered =
    countEntries(file.light) + countEntries(file.dark);
  const scheme = reviveColorScheme({
    name: file.name,
    light: file.light,
    dark: file.dark,
  });
  const kept = overrideCount(scheme);

  if (kept === 0) {
    return {
      ok: false,
      message: "Nothing in that file names a colour this version knows about.",
    };
  }
  return { ok: true, scheme, kept, ignored: offered - kept };
}

function countEntries(raw: unknown): number {
  return raw && typeof raw === "object" ? Object.keys(raw).length : 0;
}

// ---------------------------------------------------------------------------
// First paint
// ---------------------------------------------------------------------------

/**
 * The same apply logic as a source string, for the blocking `<head>` script.
 *
 * Duplicated in plain JS for the reason the theme's and the appearance's are:
 * this module cannot run before hydration, and a custom scheme that arrived a
 * frame late would mean a flash of the stock palette on every single launch —
 * far more obvious than a wrong font size, because it is the whole window.
 *
 * It reads the `dark` class rather than re-checking the OS, which is what
 * makes the ordering in `layout.tsx` load-bearing: the theme script runs
 * first and has already decided which palette this launch is in.
 */
export function colorSchemeInitScript(): string {
  const tokens = JSON.stringify(COLOR_TOKENS);
  return `(function(){try{var s=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var r=document.documentElement;var p=(r.classList.contains("dark")?s.dark:s.light)||{};${tokens}.forEach(function(t){var v=p[t];if(typeof v==="string"&&v)r.style.setProperty("--"+t,v);});}catch(e){}})();`;
}

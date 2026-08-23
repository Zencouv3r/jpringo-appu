/**
 * Colour maths, sRGB and OKLCh.
 *
 * The app's stock palette is written in OKLCh, because that is what
 * `globals.css` shipped with and rewriting those literals would change how the
 * default app looks. The colour pickers, on the other hand, speak sRGB: the
 * native `<input type="color">` only accepts `#rrggbb`, and hue/saturation/
 * lightness are the three numbers people actually reach for.
 *
 * So this module is the bridge, and it only ever runs in one direction. A
 * token the user has edited is stored as hex; a token they have not is left as
 * the OKLCh string the stylesheet declared, and is converted only on the way
 * *into* a slider — never on the way back out into the DOM. That asymmetry is
 * the point: an untouched token renders from the original literal, so a fresh
 * install looks byte-for-byte like one from before this screen existed.
 */

export interface Rgba {
  /** 0–255. */
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

export interface Hsla {
  /** Degrees, 0–360. */
  h: number;
  /** Percent, 0–100. */
  s: number;
  /** Percent, 0–100. */
  l: number;
  /** 0–1. */
  a: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

// ---------------------------------------------------------------------------
// OKLCh
// ---------------------------------------------------------------------------

/** The sRGB transfer function, applied per linear-light channel. */
function gammaEncode(channel: number): number {
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/**
 * OKLCh to sRGB, by way of OKLab and linear sRGB.
 *
 * The matrices are Ottosson's published constants. Out-of-gamut results are
 * clipped per channel rather than gamut-mapped, which is defensible here
 * because the stock palette is almost entirely neutral greys and its one
 * saturated entry sits well inside sRGB — the difference never shows.
 */
export function oklchToRgb(l: number, c: number, hDeg: number): Rgba {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ];

  const [r, g, blue] = linear.map((channel) =>
    Math.round(clamp(gammaEncode(channel), 0, 1) * 255),
  );
  return { r, g, b: blue, a: 1 };
}

/** `50%` and `0.5` both mean a half; `none` means zero, per CSS Color 4. */
function component(raw: string | undefined, scale: number): number {
  if (!raw || raw === "none") return 0;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.trim().endsWith("%") ? (value / 100) * scale : value;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEX = /^#([0-9a-f]{3,8})$/i;
const OKLCH =
  /^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)\s*(?:\/\s*([^\s)]+)\s*)?\)$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;

/**
 * Any colour the app might have stored, as sRGB.
 *
 * Tolerant on purpose: the values reaching it come from three places that can
 * all disagree — this app's own hex, `globals.css`'s OKLCh, and a scheme file
 * somebody has edited by hand. Anything unrecognisable returns `null` so the
 * caller can fall back to a default rather than silently rendering black.
 */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1];
    const byte = (text: string) => Number.parseInt(text, 16);
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = digits.split("").map((digit) => byte(digit + digit));
      return { r, g, b, a: digits.length === 4 ? a / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const [r, g, b, a] = (digits.match(/../g) as string[]).map(byte);
      return { r, g, b, a: digits.length === 8 ? a / 255 : 1 };
    }
    return null;
  }

  const oklch = OKLCH.exec(value);
  if (oklch) {
    const [, l, c, h, alpha] = oklch;
    const rgb = oklchToRgb(
      clamp(component(l, 1), 0, 1),
      Math.max(0, component(c, 0.4)),
      component(h, 360),
    );
    return {
      ...rgb,
      a: alpha === undefined ? 1 : clamp(component(alpha, 1), 0, 1),
    };
  }

  const rgb = RGB.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((part) =>
      clamp(Math.round(component(part, 255)), 0, 255),
    );
    const a = parts[3] === undefined ? 1 : clamp(component(parts[3], 1), 0, 1);
    return { r, g, b, a };
  }

  return null;
}

/** {@link parseColor} with a floor under it, for callers that must render. */
export function parseColorOr(input: string, fallback: Rgba = BLACK): Rgba {
  return parseColor(input) ?? fallback;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pair = (value: number) =>
  clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");

/**
 * `#rrggbb`, or `#rrggbbaa` when the colour is not fully opaque.
 *
 * Alpha is dropped at 1 so the common case stays six digits — the form the
 * rest of the app already writes, and the only one the native picker will
 * show back.
 */
export function toHex({ r, g, b, a }: Rgba): string {
  const base = `#${pair(r)}${pair(g)}${pair(b)}`;
  return a >= 1 ? base : `${base}${pair(a * 255)}`;
}

/** `#rrggbb` with alpha discarded, for `<input type="color">`. */
export function toOpaqueHex(color: Rgba): string {
  return toHex({ ...color, a: 1 });
}

/** `rgba(…)`, for painting a swatch over its checkerboard. */
export function toRgbaCss({ r, g, b, a }: Rgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(
    a.toFixed(3),
  )})`;
}

// ---------------------------------------------------------------------------
// HSL
// ---------------------------------------------------------------------------

export function rgbToHsl({ r, g, b, a }: Rgba): Hsla {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (span !== 0) {
    if (max === red) h = ((green - blue) / span) % 6;
    else if (max === green) h = (blue - red) / span + 2;
    else h = (red - green) / span + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = span === 0 ? 0 : span / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100, a };
}

export function hslToRgb({ h, s, l, a }: Hsla): Rgba {
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = ((((h % 360) + 360) % 360) / 60);
  const second = chroma * (1 - Math.abs((hue % 2) - 1));
  const offset = lightness - chroma / 2;

  const [r, g, b] = (
    hue < 1
      ? [chroma, second, 0]
      : hue < 2
        ? [second, chroma, 0]
        : hue < 3
          ? [0, chroma, second]
          : hue < 4
            ? [0, second, chroma]
            : hue < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  ).map((channel) => Math.round((channel + offset) * 255));

  return { r, g, b, a: clamp(a, 0, 1) };
}

/**
 * Whether text drawn over this colour should be dark.
 *
 * Relative luminance rather than plain lightness, so a saturated yellow counts
 * as a light background. Used only to keep a swatch's own label legible.
 */
export function isLight({ r, g, b }: Rgba): boolean {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) > 0.4;
}

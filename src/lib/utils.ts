import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { JlptLevel, ProgressStage, Script, Segment } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Formats a seconds offset as `m:ss`, or `h:mm:ss` past an hour. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/** "3 days ago" for the recent-files list. */
export function formatRelativeTime(unixSeconds: number): string {
  const elapsed = Date.now() / 1000 - unixSeconds;
  if (elapsed < 60) return "just now";

  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2592000, "month"],
    [31536000, "year"],
  ];

  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let divisor = 60;
  for (const [seconds, candidate] of steps) {
    if (elapsed >= seconds) {
      divisor = seconds;
      unit = candidate;
    }
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return formatter.format(-Math.floor(elapsed / divisor), unit);
}

/**
 * Finds the segment covering `time`.
 *
 * Binary search rather than a linear scan: this runs on every `timeupdate`
 * (roughly 4 Hz) against transcripts that can exceed a thousand lines.
 *
 * Segments are assumed sorted and non-overlapping, which both the whisper and
 * subtitle paths guarantee. When `time` falls in a gap between lines, the
 * preceding segment wins so the transcript does not flicker back to nothing
 * during pauses in dialogue.
 */
export function findSegmentAt(segments: Segment[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  let match = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];

    if (time < segment.start) {
      high = mid - 1;
    } else {
      // At or past this segment's start — a candidate, but a later one may
      // fit better.
      match = mid;
      if (time <= segment.end) return mid;
      low = mid + 1;
    }
  }

  return match;
}

/** Human-readable description of a pipeline stage. */
export function describeStage(stage: ProgressStage): string {
  switch (stage.stage) {
    case "readingSubtitles":
      return stage.track !== null
        ? `Checking subtitle track ${stage.track}…`
        : "Reading subtitle file…";
    case "subtitleRejected":
      return `${stage.track}: ${stage.reason}`;
    case "extractingAudio":
      return "Extracting audio…";
    case "transcribing":
      return `Transcribing… ${stage.percent}%`;
    case "tokenizing":
      return "Analyzing Japanese…";
    case "lookingUpWords":
      return stage.total > 0
        ? `Looking up new words… ${stage.done} of ${stage.total}`
        : "Looking up new words…";
    case "analyzing":
      return stage.total > 0
        ? `Explaining… batch ${stage.done} of ${stage.total}`
        : "Explaining…";
    case "done":
      return "Done";
    case "failed":
      return stage.message;
    case "cancelled":
      return "Cancelled";
  }
}

/** 0-100 for a stage, or `null` when a stage has no meaningful percentage. */
export function stagePercent(stage: ProgressStage): number | null {
  switch (stage.stage) {
    case "transcribing":
      return stage.percent;
    case "lookingUpWords":
    case "analyzing":
      return stage.total > 0
        ? Math.round((stage.done / stage.total) * 100)
        : null;
    case "done":
      return 100;
    default:
      return null;
  }
}

/** Common ISO 639 language codes seen in container metadata, expanded for readability. */
const LANGUAGE_LABELS: Record<string, string> = {
  jpn: "Japanese",
  ja: "Japanese",
  eng: "English",
  en: "English",
  spa: "Spanish",
  es: "Spanish",
  fre: "French",
  fra: "French",
  fr: "French",
  ger: "German",
  deu: "German",
  de: "German",
  kor: "Korean",
  ko: "Korean",
  chi: "Chinese",
  zho: "Chinese",
  zh: "Chinese",
  rus: "Russian",
  ru: "Russian",
  ita: "Italian",
  it: "Italian",
  por: "Portuguese",
  pt: "Portuguese",
  ara: "Arabic",
  ar: "Arabic",
  und: "Unknown",
  // Script-only fallbacks, used when a track carried no language tag at all
  // and detection could say what alphabet it was but not which language.
  latn: "Latin script",
  cyrl: "Cyrillic",
};

/** Expands a track's language tag to a readable name, or uppercases an unknown one. */
export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code.toLowerCase()] ?? code.toUpperCase();
}

/** How a detected script reads in the UI. */
export const SCRIPT_LABEL: Record<Script, string> = {
  japanese: "Japanese",
  chinese: "Chinese",
  korean: "Korean",
  latin: "Latin script",
  cyrillic: "Cyrillic",
  unknown: "Unknown",
};

/**
 * The best name available for a transcript's language.
 *
 * The container's tag wins when it has one, because "Simplified Chinese" beats
 * "Chinese" and a tag is the only place that detail exists. Detection fills in
 * for untagged tracks, where it is the only evidence there is.
 */
export function transcriptLanguageLabel(language: string, script: Script): string {
  const tag = language.trim();
  if (tag && tag !== "und" && tag !== "latn" && tag !== "cyrl") {
    return languageLabel(tag);
  }
  return SCRIPT_LABEL[script];
}

/** Tailwind classes for a JLPT badge, easiest to hardest. */
export const JLPT_CLASS: Record<Exclude<JlptLevel, "none">, string> = {
  N5: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  N4: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  N3: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  N2: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  N1: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
};

/** "1,204" — thousands separators for the frequency counts. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

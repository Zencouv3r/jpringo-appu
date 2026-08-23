"use client";

import {
  BookMarked,
  Clock,
  FileVideo,
  FolderOpen,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { useTheme } from "@/hooks/use-theme";
import type { RecentEntry } from "@/lib/types";
import { cn, formatRelativeTime, formatTimestamp } from "@/lib/utils";

interface LibraryScreenProps {
  entries: RecentEntry[];
  isOpening: boolean;
  error: string | null;
  theme: ReturnType<typeof useTheme>;
  onOpenPicker: () => void;
  onOpenPath: (path: string) => void;
  onRemove: (videoId: string) => void;
  onClear: () => void;
  onOpenSettings: () => void;
  onOpenDictionary: () => void;
}

/** The start screen: pick a file, or reopen a recent one. */
export function LibraryScreen({
  entries,
  isOpening,
  error,
  theme,
  onOpenPicker,
  onOpenPath,
  onRemove,
  onClear,
  onOpenSettings,
  onOpenDictionary,
}: LibraryScreenProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Ringo</h1>
            <p className="max-w-md text-sm text-muted-foreground">
              Open a video and get Japanese subtitles, a translation, and a per-word
              breakdown you can click through while you watch.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="sm" className="gap-1.5 rounded-[2.0px]" onClick={onOpenDictionary}>
              <BookMarked className="size-4" />
              Dictionary
            </Button>
            <ThemeToggle theme={theme} />
            <Button variant="outline" size="icon" aria-label="Settings" onClick={onOpenSettings}>
              <Settings2 />
            </Button>
          </div>
        </header>

        <button
          type="button"
          onClick={onOpenPicker}
          disabled={isOpening}
          className={cn(
            "group flex flex-col items-center justify-center gap-3 rounded-[2.0px] border-2 border-dashed border-border px-6 py-14 transition-colors",
            "hover:border-primary/50 hover:bg-accent/40",
            isOpening && "pointer-events-none opacity-60",
          )}
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-muted transition-colors group-hover:bg-primary/10">
            <FolderOpen className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
          </span>
          <span className="space-y-1 text-center">
            <span className="block text-sm font-medium">
              {isOpening ? "Opening…" : "Choose a video file"}
            </span>
            <span className="block text-xs text-muted-foreground">
              MKV, MP4, AVI, and anything else ffmpeg reads — or drop a file anywhere
            </span>
          </span>
        </button>

        {error && (
          <div className="rounded-[1.5px] border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {entries.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Recent</h2>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-xs text-muted-foreground rounded-[2.67px]"
                onClick={onClear}
              >
                Clear all
              </Button>
            </div>

            <ul className="flex flex-col gap-1">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <RecentRow
                    entry={entry}
                    onOpen={() => onOpenPath(entry.path)}
                    onRemove={() => onRemove(entry.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function RecentRow({
  entry,
  onOpen,
  onRemove,
}: {
  entry: RecentEntry;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const progress =
    entry.duration > 0 && entry.position > 0
      ? Math.min(1, entry.position / entry.duration)
      : 0;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-[1.5px] px-2 py-2 transition-colors",
        entry.exists ? "hover:bg-accent" : "opacity-55",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!entry.exists}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[1.5px] bg-muted">
          <FileVideo className="size-4 text-muted-foreground" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{entry.name}</span>
            {entry.hasAnalysis && (
              <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]">
                <Sparkles className="size-2.5" />
                Transcript
              </Badge>
            )}
          </span>

          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {!entry.exists ? (
              <span className="text-destructive/80">File not found</span>
            ) : (
              <>
                <span className="tabular-nums">{formatTimestamp(entry.duration)}</span>
                <span aria-hidden>·</span>
                <span>{formatRelativeTime(entry.openedAt)}</span>
                {progress > 0.01 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {Math.round(progress * 100)}% watched
                    </span>
                  </>
                )}
              </>
            )}
          </span>

          {progress > 0.01 && entry.exists && (
            <span className="mt-1.5 block h-0.5 w-full overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full bg-primary/70"
                style={{ width: `${progress * 100}%` }}
              />
            </span>
          )}
        </span>
      </button>

      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${entry.name} from recents`}
        className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

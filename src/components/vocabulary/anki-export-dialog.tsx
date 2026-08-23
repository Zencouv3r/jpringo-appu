"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import * as ipc from "@/lib/ipc";
import {
  DEFAULT_ANKI_OPTIONS,
  WORD_CATEGORIES,
  type AnkiExport,
  type AnkiOptions,
  type AnkiPreview,
  type VocabSourceSummary,
  type WordCategory,
} from "@/lib/types";
import { cn, formatCount } from "@/lib/utils";

/** Sentinel for "no series filter" — Base UI's Select has no null value. */
const ALL_SERIES = "__everything__";

/** Options settle before the preview re-runs, so typing "150" is one query. */
const PREVIEW_DEBOUNCE_MS = 120;

interface AnkiExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Series the log has words from, for the scope filter. */
  sources: VocabSourceSummary[];
  /** The dictionary's current series filter, used as the starting scope. */
  initialSeries?: string | null;
}

/**
 * Choosing what to send to Anki.
 *
 * Every control here narrows the same list, and the preview underneath is the
 * point of the dialog: an export is a file you then have to import, notice is
 * wrong, delete, and redo — so the count and the first few rows are shown
 * before anything is written rather than after.
 */
export function AnkiExportDialog({
  open,
  onOpenChange,
  sources,
  initialSeries,
}: AnkiExportDialogProps) {
  const [options, setOptions] = useState<AnkiOptions>(DEFAULT_ANKI_OPTIONS);
  const [preview, setPreview] = useState<AnkiPreview | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [result, setResult] = useState<AnkiExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against an earlier preview resolving after a later one.
  const requestRef = useRef(0);

  // Reset on each open. Done during render rather than in an effect so a
  // previous run's result is never briefly visible above fresh options.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOptions({ ...DEFAULT_ANKI_OPTIONS, series: initialSeries ?? null });
      setResult(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const request = ++requestRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await ipc.previewAnkiExport(options);
          if (requestRef.current === request) setPreview(next);
        } catch {
          // A failed preview is not worth an error banner: the export button
          // reports for real, and the count simply stays as it was.
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, options]);

  const patch = (change: Partial<AnkiOptions>) => {
    setOptions((current) => ({ ...current, ...change }));
    setResult(null);
    setError(null);
  };

  const toggleCategory = (category: WordCategory) => {
    patch({
      categories: options.categories.includes(category)
        ? options.categories.filter((value) => value !== category)
        : [...options.categories, category],
    });
  };

  const handleExport = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await ipc.pickSaveFile({
      title: "Save the Anki import file",
      defaultPath: `ringo-anki-${stamp}.txt`,
      filters: [{ name: "Anki import", extensions: ["txt", "tsv", "csv"] }],
    });
    if (!path) return;

    setIsExporting(true);
    setError(null);
    try {
      setResult(await ipc.exportAnki(options, path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The export failed.");
    } finally {
      setIsExporting(false);
    }
  };

  const countFor = (category: WordCategory) =>
    preview?.counts.find((entry) => entry.category === category)?.words ?? 0;

  const nothingToExport = !preview || preview.cards === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export to Anki</DialogTitle>
          <DialogDescription>
            Writes a tab-separated text file. In Anki, use File → Import and pick
            it — the columns are word, reading, meaning, example, and the
            example&apos;s translation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <Label>Word types</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {WORD_CATEGORIES.map(({ value, label }) => {
                const selected = options.categories.includes(value);
                return (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    className="justify-between gap-1.5"
                    aria-pressed={selected}
                    onClick={() => toggleCategory(value)}
                  >
                    <span className="truncate">{label}</span>
                    <span
                      className={cn(
                        "text-[10px] tabular-nums",
                        selected ? "opacity-70" : "text-muted-foreground",
                      )}
                    >
                      {formatCount(countFor(value))}
                    </span>
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Counts are what each type would add under the filters below.
              Particles are off by default — they are the most frequent words in
              any transcript and the least useful as cards.
            </p>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-medium">How many</h3>

            <div className="flex items-center gap-3">
              <Label htmlFor="anki-limit" className="w-40 shrink-0">
                Most frequent
              </Label>
              <Input
                id="anki-limit"
                type="number"
                min={0}
                // Empty rather than 0, because "0" reads as "none" while the
                // placeholder says what it actually means.
                value={options.limit === 0 ? "" : options.limit}
                onChange={(event) =>
                  patch({ limit: Math.max(0, Number(event.target.value) || 0) })
                }
                placeholder="All of them"
                className="h-8"
              />
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                words
              </span>
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="anki-min-count" className="w-40 shrink-0">
                Seen at least
              </Label>
              <Input
                id="anki-min-count"
                type="number"
                min={0}
                value={options.minCount === 0 ? "" : options.minCount}
                onChange={(event) =>
                  patch({ minCount: Math.max(0, Number(event.target.value) || 0) })
                }
                placeholder="1"
                className="h-8"
              />
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                times
              </span>
            </div>

            <div className="flex items-center gap-3">
              <Label className="w-40 shrink-0">From</Label>
              <Select
                value={options.series ?? ALL_SERIES}
                onValueChange={(value) =>
                  patch({ series: value === ALL_SERIES ? null : value })
                }
              >
                <SelectTrigger size="sm" className="flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SERIES}>Everything watched</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source.series} value={source.series}>
                      {source.series} ({formatCount(source.wordCount)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="w-16 shrink-0" />
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-medium">Cards</h3>

            <ToggleRow
              label="Furigana readings"
              description="Writes 食[た]べる instead of たべる, which Anki's Japanese Support add-on renders as ruby. Harmless without it."
              checked={options.furigana}
              onChange={(furigana) => patch({ furigana })}
            />

            <ToggleRow
              label="Only words with a meaning"
              description={
                preview && preview.withoutMeaning > 0
                  ? `${formatCount(preview.withoutMeaning)} words haven't been looked up yet and would export with an empty back.`
                  : "Words waiting on the explanations pass would export with an empty back."
              }
              checked={options.requireMeaning}
              onChange={(requireMeaning) => patch({ requireMeaning })}
            />

            <ToggleRow
              label="Add tags"
              description="A sixth column Anki files rather than shows: ringo::pos::noun, ringo::jlpt::N5, ringo::series::…"
              checked={options.includeTags}
              onChange={(includeTags) => patch({ includeTags })}
            />
          </section>

          <Separator />

          <Preview preview={preview} />

          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              {error}
            </p>
          )}

          {result && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Check className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-all">
                Wrote {formatCount(result.cards)}{" "}
                {result.cards === 1 ? "card" : "cards"} to {result.path}
              </span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={isExporting || nothingToExport}
          >
            {isExporting ? <Loader2 className="animate-spin" /> : <Download />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the current options add up to, and what a row will look like. */
function Preview({ preview }: { preview: AnkiPreview | null }) {
  if (!preview) {
    return (
      <p className="text-xs text-muted-foreground">Working out what matches…</p>
    );
  }

  if (preview.cards === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing matches these options. Widen the word types, lower the
        &ldquo;seen at least&rdquo; number, or turn off &ldquo;only words with a
        meaning&rdquo;.
      </p>
    );
  }

  return (
    <section className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground">
          {formatCount(preview.cards)} {preview.cards === 1 ? "card" : "cards"}
        </span>
        {preview.matched > preview.cards && (
          <> of {formatCount(preview.matched)} matching words</>
        )}{" "}
        · {formatCount(preview.withExample)} with an example sentence
      </p>

      <div className="space-y-2 rounded-[1.5px] border border-border bg-muted/40 p-3">
        {preview.sample.map((card) => (
          <div key={card.word} className="space-y-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">{card.word}</span>
              {card.reading && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {card.reading}
                </span>
              )}
            </p>
            <p className="text-xs">{card.meaning}</p>
            {card.example && (
              <p className="text-xs text-muted-foreground">
                {card.example}
                {card.exampleTranslation && ` — ${card.exampleTranslation}`}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </label>
  );
}

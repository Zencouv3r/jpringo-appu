"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Palette,
  SlidersHorizontal,
} from "lucide-react";

import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { ColorSchemeSettings } from "@/components/settings/color-scheme-settings";
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
import type { useAppearance } from "@/hooks/use-appearance";
import type { useColorScheme } from "@/hooks/use-color-scheme";
import { useLivePreview } from "@/hooks/use-live-preview";
import type { usePlaybackKeys } from "@/hooks/use-playback-keys";
import type { useSettings } from "@/hooks/use-settings";
import type { useSubtitleStyle } from "@/hooks/use-subtitle-style";
import type { useTheme } from "@/hooks/use-theme";
import * as ipc from "@/lib/ipc";
import type { ReasoningEffort } from "@/lib/types";
import { cn, formatBytes } from "@/lib/utils";

const REASONING_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "", label: "Not set" },
];

/** Which screen of the dialog is showing. */
type View = "main" | "customization" | "appearance";

/**
 * What the dialog looks like while a colour is being dragged.
 *
 * Not merely dimmed: the surface itself goes, so what is left over the app is
 * the controls rather than a translucent sheet tinted by the very colour being
 * chosen. The ring and the shadow go with it for the same reason. See
 * {@link useLivePreview} for why any of this happens.
 */
const PREVIEW_CLASSES = "bg-transparent opacity-40 shadow-none ring-transparent";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ReturnType<typeof useSettings>;
  appearance: ReturnType<typeof useAppearance>;
  colors: ReturnType<typeof useColorScheme>;
  subtitles: ReturnType<typeof useSubtitleStyle>;
  playbackKeys: ReturnType<typeof usePlaybackKeys>;
  theme: ReturnType<typeof useTheme>;
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings: state,
  appearance,
  colors,
  subtitles,
  playbackKeys,
  theme,
}: SettingsDialogProps) {
  const { settings, update, setApiKey, clearCache, clearVocabulary } = state;

  const [view, setView] = useState<View>("main");
  // Owned here rather than by the colour screen: the thing that has to get out
  // of the way is this dialog and the backdrop behind it, and neither is that
  // screen's to move.
  const preview = useLivePreview();
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "saved">("idle");
  // The tick beside Save clears itself after a couple of seconds. Held so
  // closing the dialog in between cancels it rather than leaving a timer
  // pointing at a component nobody is looking at.
  const keyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (keyStatusTimer.current) clearTimeout(keyStatusTimer.current);
  }, []);
  const [isClearing, setIsClearing] = useState(false);
  const [isClearingWords, setIsClearingWords] = useState(false);
  // The data folder is applied on demand rather than per keystroke: saving it
  // *creates* the directory, and half a typed path would leave a stray folder
  // behind for every character.
  const [folderDraft, setFolderDraft] = useState("");

  // Clear the draft each time the dialog opens — the stored key is never
  // readable, so leaving stale text in the field would misrepresent it.
  // Done during render rather than in an effect so the old draft is never
  // briefly visible on reopen.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKeyDraft("");
      setShowKey(false);
      setKeyStatus("idle");
      setFolderDraft(settings?.dataDir ?? "");
      setView("main");
      // A dialog that reopened at 40% because the last drag ended as it closed
      // would look broken, and nothing on screen would explain why. Guarded so
      // it is a no-op on every ordinary open.
      if (preview.isPreviewing) preview.release();
    }
  }

  if (!settings) return null;

  const handleSaveKey = async () => {
    setKeyStatus("saving");
    try {
      await setApiKey(keyDraft.trim() || null);
    } catch {
      // The key is written to a file in the app's own config folder; the only
      // way this fails is that folder being unwritable, which the data-folder
      // notice above already reports. Leaving the button spinning forever
      // would be the worse outcome.
      setKeyStatus("idle");
      return;
    }
    setKeyDraft("");
    setKeyStatus("saved");
    if (keyStatusTimer.current) clearTimeout(keyStatusTimer.current);
    keyStatusTimer.current = setTimeout(() => setKeyStatus("idle"), 2000);
  };

  const handleClearVocabulary = async () => {
    setIsClearingWords(true);
    try {
      await clearVocabulary();
    } finally {
      setIsClearingWords(false);
    }
  };

  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      await clearCache();
    } finally {
      setIsClearing(false);
    }
  };

  const applyFolder = async (path: string | null) => {
    setFolderDraft(path ?? "");
    await update({ dataDir: path });
  };

  const handleBrowseFolder = async () => {
    const picked = await ipc.pickFolder("Where Ringo keeps its files");
    if (picked) await applyFolder(picked);
  };

  const folderChanged = folderDraft.trim() !== (settings.dataDir ?? "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // The transition is unconditional so coming *back* is as smooth as
          // going away; only the destination is conditional.
          "max-h-[85vh] overflow-y-auto transition-opacity sm:max-w-lg",
          preview.isPreviewing && PREVIEW_CLASSES,
        )}
        // The backdrop dims and blurs the app, which is precisely what must
        // not happen while a colour is being judged against it.
        overlayClassName={cn(
          "transition-opacity",
          preview.isPreviewing && "opacity-0",
        )}
      >
        <DialogHeader>
          {view === "customization" ? (
            <>
              <BackRow title="Customization" onBack={() => setView("main")} />
              <DialogDescription>
                Sizes, theme, and what the arrow keys do. Stored on this machine
                rather than in settings.json — a size that reads well here is
                wrong elsewhere.
              </DialogDescription>
            </>
          ) : view === "appearance" ? (
            <>
              <BackRow title="Appearance" onBack={() => setView("main")} />
              <DialogDescription>
                The colour of every part of the interface, for both themes.
                This dialog gets out of the way while you drag, so a colour is
                judged against the app rather than against a swatch.
              </DialogDescription>
            </>
          ) : (
            <>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>
                Transcription runs locally; only the translation step uses the
                network.
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {view === "customization" ? (
          <AppearanceSettings
            appearance={appearance}
            subtitles={subtitles}
            playbackKeys={playbackKeys}
            theme={theme}
          />
        ) : view === "appearance" ? (
          <ColorSchemeSettings colors={colors} theme={theme} preview={preview} />
        ) : (
          <div className="space-y-5">
            <SubmenuRow
              icon={SlidersHorizontal}
              label="Customization"
              description="Interface size, transcript size, subtitle size, theme, and the arrow keys."
              onClick={() => setView("customization")}
            />

            <SubmenuRow
              icon={Palette}
              label="Appearance"
              description="Recolour any part of the interface, and export or import the scheme."
              onClick={() => setView("appearance")}
            />

            <Separator />

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="api-key">OpenAI API key</Label>
                {settings.hasApiKey && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="size-3" />
                    Key saved
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="api-key"
                    type={showKey ? "text" : "password"}
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={settings.hasApiKey ? "••••••••  (replace)" : "sk-…"}
                    autoComplete="off"
                    spellCheck={false}
                    className="pr-9 font-mono text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={showKey ? "Hide key" : "Show key"}
                    className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                </div>

                <Button onClick={handleSaveKey} disabled={keyStatus === "saving"}>
                  {keyStatus === "saving" ? (
                    <Loader2 className="animate-spin" />
                  ) : keyStatus === "saved" ? (
                    <Check />
                  ) : null}
                  Save
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Stored in this app&apos;s config folder and used only to call OpenAI. Leave the
                field empty and press Save to remove it.
              </p>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Transcription</h3>

              <div className="space-y-1.5">
                <Label htmlFor="model-path">Whisper model</Label>
                <TextField
                  id="model-path"
                  value={settings.modelPath ?? ""}
                  placeholder={settings.resolvedModelPath ?? "Auto-detect from models/"}
                  onCommit={(modelPath) => void update({ modelPath })}
                  className="font-mono text-xs"
                />
                {settings.modelAvailable ? (
                  <p className="truncate text-xs text-muted-foreground">
                    Using {settings.resolvedModelPath}
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <CircleAlert className="mt-px size-3.5 shrink-0" />
                    No model found. Put a ggml <code>.bin</code> file in the models folder.
                  </p>
                )}
              </div>

              <ToggleRow
                label="Use existing subtitles"
                description="Read the file's Japanese subtitle track instead of transcribing, when it has one."
                checked={settings.preferExistingSubtitles}
                onChange={(checked) => void update({ preferExistingSubtitles: checked })}
              />

              <ToggleRow
                label="GPU acceleration"
                description={
                  settings.gpuAvailable
                    ? "Use the GPU whisper build. Much faster than CPU."
                    : "No GPU build installed — run scripts/fetch-sidecars.ps1 -Cuda to add one."
                }
                checked={settings.useGpu && settings.gpuAvailable}
                disabled={!settings.gpuAvailable}
                onChange={(checked) => void update({ useGpu: checked })}
              />

              <div className="space-y-1.5">
                <Label htmlFor="threads">CPU threads</Label>
                <NumberField
                  id="threads"
                  value={settings.whisperThreads}
                  min={1}
                  max={32}
                  fallback={4}
                  onCommit={(whisperThreads) => void update({ whisperThreads })}
                  className="w-24"
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Breakdown</h3>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="openai-model">Model</Label>
                  <TextField
                    id="openai-model"
                    value={settings.openaiModel}
                    onCommit={(openaiModel) =>
                      // Empty means "put the default back", which is what Rust
                      // does with a blank name anyway.
                      void update({ openaiModel: openaiModel ?? "" })
                    }
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="reasoning-effort">Reasoning</Label>
                  <Select
                    value={settings.reasoningEffort}
                    onValueChange={(value) =>
                      void update({ reasoningEffort: value as ReasoningEffort })
                    }
                  >
                    <SelectTrigger id="reasoning-effort" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REASONING_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Reasoning tokens dominate the cost and the wait — on a 40-line batch,{" "}
                <code>gpt-5</code> spent more than half its output thinking.{" "}
                <code>minimal</code> costs a fraction and loses almost nothing here, since
                the prompt asks for word-level terms explicitly. Raise it if JLPT levels
                look unreliable. Non-GPT-5 models need &ldquo;Not set&rdquo;.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="batch-size">Lines per request</Label>
                  <NumberField
                    id="batch-size"
                    value={settings.batchSize}
                    min={5}
                    max={200}
                    fallback={40}
                    onCommit={(batchSize) => void update({ batchSize })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="concurrency">Parallel requests</Label>
                  <NumberField
                    id="concurrency"
                    value={settings.concurrency}
                    min={1}
                    max={8}
                    fallback={3}
                    onCommit={(concurrency) => void update({ concurrency })}
                  />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Playback &amp; storage</h3>

              <ToggleRow
                label="Prepare files for exact seeking"
                description="Convert non-web formats in the background so seeking is instant instead of restarting the stream. Uses disk space."
                checked={settings.prepareRemux}
                onChange={(checked) => void update({ prepareRemux: checked })}
              />

              <div className="space-y-1.5">
                <Label htmlFor="data-dir">Data folder</Label>
                <div className="flex gap-2">
                  <Input
                    id="data-dir"
                    value={folderDraft}
                    onChange={(event) => setFolderDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !folderChanged) return;
                      event.preventDefault();
                      void applyFolder(folderDraft.trim() || null);
                    }}
                    placeholder={settings.defaultDataDir ?? "Beside the app"}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  {folderChanged ? (
                    <Button onClick={() => void applyFolder(folderDraft.trim() || null)}>
                      Apply
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => void handleBrowseFolder()}>
                      <FolderOpen />
                      Browse
                    </Button>
                  )}
                </div>

                {settings.dataDirAvailable ? (
                  <p className="truncate text-xs text-muted-foreground">
                    Using {settings.resolvedDataDir}
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <CircleAlert className="mt-px size-3.5 shrink-0" />
                    That folder can&apos;t be written to. Writing to{" "}
                    {settings.resolvedDataDir} instead.
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  Cached transcripts, converted video, and the vocabulary log all live
                  here — beside the app by default, so nothing lands on the system drive
                  unless you put it there. Changing the folder starts a fresh one;
                  files already written stay where they are.
                  {settings.dataDir && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() => void applyFolder(null)}
                      >
                        Use the default
                      </button>
                      .
                    </>
                  )}
                </p>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-[1.5px] border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm">Cached transcripts and video</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(settings.cacheBytes)} on disk
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearCache}
                  disabled={isClearing || settings.cacheBytes === 0}
                >
                  {isClearing && <Loader2 className="animate-spin" />}
                  Clear
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-[1.5px] border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm">Vocabulary log</p>
                  {/* Spelled out because this is the one destructive button that
                      throws away something that cost money: the cached senses
                      live here, and clearing them means paying to look every
                      word up again. */}
                  <p className="text-xs text-muted-foreground">
                    {settings.vocabularyWords.toLocaleString()} words met, with their
                    meanings. Clearing loses the frequency history and makes the next
                    breakdown re-look-up every word.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearVocabulary}
                  disabled={isClearingWords || settings.vocabularyWords === 0}
                >
                  {isClearingWords && <Loader2 className="animate-spin" />}
                  Clear
                </Button>
              </div>
            </section>
          </div>
        )}

        <DialogFooter>
          {view === "main" ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button variant="outline" onClick={() => setView("main")}>
              Back
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The title of a subscreen, with the way back out of it. */
function BackRow({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        className="-ml-1"
        aria-label="Back to settings"
        onClick={onBack}
      >
        <ArrowLeft />
      </Button>
      <DialogTitle>{title}</DialogTitle>
    </div>
  );
}

/** A row that opens one of the dialog's subscreens. */
function SubmenuRow({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: typeof SlidersHorizontal;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[1.5px] border border-border p-3 text-left transition-colors hover:bg-muted/60"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * A string that is only saved once you have finished typing it.
 *
 * The same problem [`NumberField`] solves, in its milder form. Rust replaces
 * an empty model name with the default and hands it back, so clearing the
 * field to retype it filled the box with `gpt-5-mini` mid-edit. Every
 * keystroke also wrote `settings.json` and rebuilt the settings view, which
 * walks the whole cache folder to total its size — a directory tree of
 * multi-gigabyte remuxes, once per character.
 *
 * Empty commits as `null`, which both fields read as "work it out yourself":
 * auto-detect the model file, or use the default model name.
 */
function TextField({
  id,
  value,
  placeholder,
  onCommit,
  className,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string | null) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== value) onCommit(next || null);
  };

  return (
    <Input
      id={id}
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
      className={className}
    />
  );
}

/**
 * A number that is only saved once you have finished typing it.
 *
 * Every other control here writes straight through to `settings.json`, which
 * is right for a switch and wrong for a number: Rust clamps what it is given
 * and hands the clamped value back, so a field bound directly to it is
 * rewritten between keystrokes. Typing `100` into "lines per request" went
 * `1` → clamped to `5` → `50` → `500` → clamped to `200`, and there was no
 * sequence of keys that produced `100` at all. Clearing the field to start
 * over was worse still: an empty string reads as zero, which the fallback
 * turned into the default and saved.
 *
 * So the draft is local while it is being edited, and the commit happens on
 * blur or Enter — the same shape the data-folder field already uses, for the
 * same reason. Escape abandons the edit.
 */
function NumberField({
  id,
  value,
  min,
  max,
  fallback,
  onCommit,
  className,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  /** Used for a field left empty, which is not a number the user meant. */
  fallback: number;
  onCommit: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.trim());
    const next = draft.trim() === "" || !Number.isFinite(parsed) ? fallback : parsed;
    setDraft(null);
    // Clamped here as well as in Rust so the field settles on the number that
    // was actually stored rather than snapping a moment later.
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(null);
        }
      }}
      className={className}
    />
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mt-0.5 shrink-0"
      />
    </label>
  );
}

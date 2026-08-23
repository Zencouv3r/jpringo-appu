"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  AudioLines,
  BookMarked,
  Gauge,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Settings2,
  Sparkles,
} from "lucide-react";

import { LibraryScreen } from "@/components/library/library-screen";
import { VideoPlayer } from "@/components/player/video-player";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { TranscriptPanel } from "@/components/transcript/transcript-panel";
import { TranscriptResizer } from "@/components/transcript/transcript-resizer";
import { VocabularyScreen } from "@/components/vocabulary/vocabulary-screen";
import { WordPanel, type WordSelection } from "@/components/word/word-panel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAnalysis } from "@/hooks/use-analysis";
import { useAppearance } from "@/hooks/use-appearance";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { CHROME_PROPS, useImmersive } from "@/hooks/use-immersive";
import { useLibrary } from "@/hooks/use-library";
import { usePlayer } from "@/hooks/use-player";
import { usePlayerLayout } from "@/hooks/use-player-layout";
import { usePlaybackKeys } from "@/hooks/use-playback-keys";
import { useSettings } from "@/hooks/use-settings";
import { useSubtitleStyle } from "@/hooks/use-subtitle-style";
import { useTheme } from "@/hooks/use-theme";
import { useVideo } from "@/hooks/use-video";
import { transcriptWidthCss } from "@/lib/layout";
import type { Segment, Token } from "@/lib/types";
import { cn, findSegmentAt } from "@/lib/utils";

/**
 * How long a subtitle stays up after its line ends.
 *
 * The transcript panel keeps the last line highlighted through a silence so it
 * never flickers back to nothing, but a subtitle that behaved that way would
 * sit over the picture for the length of an opening theme. A short grace
 * period covers timing slop between closely spaced lines without that.
 */
const SUBTITLE_LINGER_SECONDS = 0.75;

export function RingoApp() {
  const library = useLibrary();
  const settings = useSettings();
  const theme = useTheme();
  // Fed the resolved theme rather than the preference: a scheme carries a
  // palette for each, and only the one on screen is written to the document.
  const colorScheme = useColorScheme(theme.resolvedTheme);
  const appearance = useAppearance();
  const { layout, resize, resetWidth, swapSide, toggleVisible, hide } = usePlayerLayout();
  const playbackKeys = usePlaybackKeys();
  const { video, isOpening, error, open, openWithPicker, close, switchAudioTrack } = useVideo();

  // Whether reading a transcript out of this file is free. A file that carries
  // text subtitles loads one by itself; one that doesn't has to wait for the
  // user to ask for whisper.
  const hasSubtitles = Boolean(
    video && (video.subtitleTracks.some((t) => t.textual) || video.externalSubtitles.length > 0),
  );
  const analysis = useAnalysis(video?.id ?? null, hasSubtitles);
  const subtitleStyle = useSubtitleStyle();

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selection, setSelection] = useState<WordSelection | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Non-null while the dictionary is open; the string is the word to open on.
  const [dictionaryLemma, setDictionaryLemma] = useState<string | null>(null);
  const [isDictionaryOpen, setIsDictionaryOpen] = useState(false);

  const player = usePlayer({
    videoId: video?.id ?? null,
    streamUrl: video?.streamUrl ?? null,
    duration: video?.duration ?? 0,
    seekIsApproximate: video?.seekIsApproximate ?? false,
    initialPosition: video?.position ?? 0,
  });

  const segments = useMemo(() => analysis.analysis?.segments ?? [], [analysis.analysis]);
  const activeSegmentIndex = useMemo(
    () => (segments.length > 0 ? findSegmentAt(segments, player.currentTime) : -1),
    [segments, player.currentTime],
  );
  const activeSegment = segments[activeSegmentIndex] ?? null;
  const subtitleSegment =
    activeSegment && player.currentTime <= activeSegment.end + SUBTITLE_LINGER_SECONDS
      ? activeSegment
      : null;

  const { seek, pause } = player;
  const immersive = useImmersive(isFullscreen);

  // Fullscreen has no room for a sidebar of its own, so it overrules the
  // stored preference without changing it: leaving fullscreen puts the
  // transcript back exactly as it was.
  const showSidebar = layout.visible && !isFullscreen;

  /**
   * Puts the transcript away, or brings it back — the button in the header
   * and the `t` key.
   *
   * Ignored in fullscreen, where the sidebar is hidden either way: a toggle
   * that silently changed what the window looks like after you leave
   * fullscreen would be indistinguishable from a broken one.
   */
  const toggleTranscript = useCallback(() => {
    if (!isFullscreen) toggleVisible();
  }, [isFullscreen, toggleVisible]);

  // Which way round the header's toggle points: shut it on the side it is on,
  // open it back onto the same side.
  const TranscriptToggleIcon =
    layout.side === "right"
      ? layout.visible
        ? PanelRightClose
        : PanelRight
      : layout.visible
        ? PanelLeftClose
        : PanelLeft;

  const handleSelectWord = useCallback((token: Token, segment: Segment) => {
    setSelection({ token, segment });
  }, []);

  const openDictionary = useCallback(
    (lemma: string | null) => {
      // The dictionary is layered over the player rather than replacing it,
      // so without this the video would go on playing to a screen nobody can
      // see. It stays paused on the way back: a video that resumed itself
      // while you were reading is its own kind of surprise.
      pause();
      setDictionaryLemma(lemma);
      setIsDictionaryOpen(true);
    },
    [pause],
  );

  const closeDictionary = useCallback(() => {
    setIsDictionaryOpen(false);
    setDictionaryLemma(null);
  }, []);

  /** Jumps back to the start of the line currently being spoken. */
  const handleReplayLine = useCallback(() => {
    const segment = segments[activeSegmentIndex];
    if (segment) seek(segment.start);
  }, [segments, activeSegmentIndex, seek]);

  /**
   * Steps to the start of the line `delta` places away — what the arrows
   * beside the subtitle do.
   *
   * Counted in lines rather than seconds, which is the point: a fixed rewind
   * either clips the start of a line or overshoots into the one before it,
   * and how far back a line begins is something only the transcript knows.
   * From before the first line there is nothing behind, so only forward moves.
   */
  const handleStepLine = useCallback(
    (delta: number) => {
      const index = activeSegmentIndex < 0 ? (delta > 0 ? 0 : -1) : activeSegmentIndex + delta;
      const target = segments[index];
      if (target) seek(target.start);
    },
    [segments, activeSegmentIndex, seek],
  );

  // Opening a different file invalidates the selected word, which points at a
  // segment from the previous transcript. Adjusted during render rather than
  // in an effect so the stale selection never paints — see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [selectionVideoId, setSelectionVideoId] = useState(video?.id ?? null);
  if (selectionVideoId !== (video?.id ?? null)) {
    setSelectionVideoId(video?.id ?? null);
    setSelection(null);
  }

  // Refresh recents when returning to the library, so the newly watched file
  // appears with its updated position and analysis badge.
  useEffect(() => {
    if (!video) void library.refresh();
    // `library` is recreated each render; only the transition matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  const toggleFullscreen = useCallback(async () => {
    try {
      const window = getCurrentWindow();
      const next = !(await window.isFullscreen());
      await window.setFullscreen(next);
      setIsFullscreen(next);
    } catch {
      // Running in a plain browser during `next dev` — no window API.
      setIsFullscreen((value) => !value);
    }
  }, []);

  // Dropping a file anywhere in the window opens it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const [path] = event.payload.paths;
        if (path) void open(path);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running inside Tauri; drag-and-drop simply isn't available.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  // The dictionary covers everything ever watched, so it opens from the
  // library screen and from inside a video alike. With no video open there is
  // nothing to preserve behind it, so it simply takes the screen.
  if (isDictionaryOpen && !video) {
    return <VocabularyScreen initialLemma={dictionaryLemma} onClose={closeDictionary} />;
  }

  if (!video) {
    return (
      <>
        <LibraryScreen
          entries={library.entries}
          isOpening={isOpening}
          error={error}
          theme={theme}
          onOpenPicker={() => void openWithPicker()}
          onOpenPath={(path) => void open(path)}
          onRemove={(id) => void library.remove(id)}
          onClear={() => void library.clear()}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenDictionary={() => openDictionary(null)}
        />
        <SettingsDialog
          open={isSettingsOpen}
          onOpenChange={setIsSettingsOpen}
          settings={settings}
          appearance={appearance}
          colors={colorScheme}
          subtitles={subtitleStyle}
          playbackKeys={playbackKeys}
          theme={theme}
        />
      </>
    );
  }

  const hasApiKey = settings.settings?.hasApiKey ?? false;
  const canExplain = Boolean(analysis.analysis && analysis.isJapanese);

  return (
    <>
      {/* Hidden rather than unmounted while the dictionary is up. Tearing
          this tree down takes the `<video>` element with it, and what React
          mounts on the way back is a *different* element: a fresh one, with
          none of the buffer, the decoder state, or the source that the old
          one had. `usePlayer` re-wires itself onto whatever element it is
          handed, but not paying that cost at all is better still. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", isDictionaryOpen && "hidden")}>
        <header
          {...CHROME_PROPS}
          className={cn(
            "flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5",
            immersive.isHidden && "hidden",
          )}
        >
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={close}>
            <ArrowLeft className="size-4" />
            Library
          </Button>

          <span className="min-w-0 flex-1 truncate text-sm font-medium">{video.name}</span>

          {video.seekIsApproximate && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-1 rounded-[1.5px] bg-muted px-2 py-1 text-xs text-muted-foreground" />
                }
              >
                <Gauge className="size-3" />
                Approximate seeking
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                This format needs converting to play in the app. Seeking restarts the stream
                until the background conversion finishes, then becomes instant.
              </TooltipContent>
            </Tooltip>
          )}

          {/* The two halves of the work, as two buttons. Transcribing is local
              and free but slow; explaining is fast but costs money. Neither ever
              triggers the other. */}
          {!analysis.isRunning && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={analysis.analysis ? "ghost" : "default"}
                      size="sm"
                      onClick={() => void analysis.transcribe(false)}
                      className="rounded-[2.2px]"
                    />
                  }
                >
                  <AudioLines className="size-3.5 rounded-[2.0px]" />
                  Transcribe audio
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Runs whisper over the audio locally — several minutes for an episode,
                  and the only option for a file with no subtitle track.
                </TooltipContent>
              </Tooltip>

              {canExplain && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={analysis.analysis?.analyzed ? "ghost" : "default"}
                        size="sm"
                        onClick={hasApiKey ? () => void analysis.explain() : () => setIsSettingsOpen(true)}
                        className="rounded-[2.5px]"
                      />
                    }
                  >
                    <Sparkles className="size-3.5" />
                    {analysis.analysis?.analyzed ? "Redo explanations" : "Explain"}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {hasApiKey
                      ? "Translates every line and explains each word in context. New words are looked up once and reused across videos; the in-context notes are regenerated each time."
                      : "Needs an OpenAI API key — click to add one in Settings."}
                  </TooltipContent>
                </Tooltip>
              )}
            </>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Dictionary"
                  onClick={() => openDictionary(null)}
                />
              }
            >
              <BookMarked />
            </TooltipTrigger>
            <TooltipContent>Every word you&apos;ve met</TooltipContent>
          </Tooltip>

          {/* Fullscreen leaves it out entirely rather than showing a control
              that cannot do anything from there. */}
          {!isFullscreen && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={layout.visible ? "Hide the transcript" : "Show the transcript"}
                    onClick={toggleTranscript}
                  />
                }
              >
                <TranscriptToggleIcon />
              </TooltipTrigger>
              <TooltipContent>
                {layout.visible ? "Hide the transcript (t)" : "Show the transcript (t)"}
              </TooltipContent>
            </Tooltip>
          )}

          <ThemeToggle theme={theme} />

          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => setIsSettingsOpen(true)}
          >
            <Settings2 />
          </Button>
        </header>

        <div
          className={cn(
            "flex min-h-0 flex-1",
            // Which side the transcript is on is a direction, not a different
            // tree. Reversing the row leaves the DOM order as video then
            // transcript, so the reading order and the tab order stay put
            // whichever side it has been moved to.
            layout.side === "left" && "flex-row-reverse",
          )}
        >
          <main className="relative flex min-w-0 flex-1 flex-col">
            <VideoPlayer
              player={player}
              title={video.name}
              segments={segments}
              subtitleSegment={subtitleSegment}
              subtitles={subtitleStyle}
              selection={selection}
              onSelectWord={handleSelectWord}
              audioTracks={video.audioTracks}
              currentAudioTrack={video.audioTrack}
              onSwitchAudioTrack={(track) => void switchAudioTrack(track)}
              onReplayLine={handleReplayLine}
              onStepLine={handleStepLine}
              canStepBack={activeSegmentIndex > 0}
              canStepForward={
                segments.length > 0 && activeSegmentIndex < segments.length - 1
              }
              arrowKeys={playbackKeys.keys}
              // The same exit as the Library button beside the file name, so
              // `esc` leaves a windowed player the way the header does.
              onExitToLibrary={close}
              isFullscreen={isFullscreen}
              onToggleFullscreen={() => void toggleFullscreen()}
              isChromeHidden={immersive.isHidden}
              onToggleChrome={immersive.toggle}
              showHideHint={immersive.showHint}
              // Another screen over the player takes its keyboard with it:
              // `space` while reading the dictionary belongs to the
              // dictionary, not to a video nobody can see.
              hasFocus={!isDictionaryOpen && !isSettingsOpen}
              onToggleTranscript={toggleTranscript}
            />

            {/* With no sidebar — fullscreen, or the transcript put away — a
                word clicked in the subtitles would open a panel nobody can
                see. Floating it over the picture is what makes clicking a
                subtitle word work at all in the mode the subtitles exist for.
                It sits on whichever side the transcript would have been, so
                the breakdown keeps turning up where it always does. */}
            {!showSidebar && selection && (
              <div
                className={cn(
                  "absolute top-4 z-20 flex h-[26rem] max-h-[70%] w-[24rem] max-w-[45%] flex-col overflow-hidden rounded-[1.5px] bg-background/95 shadow-xl ring-1 ring-white/15 backdrop-blur",
                  layout.side === "left" ? "left-4" : "right-4",
                )}
              >
                <WordPanel
                  selection={selection}
                  onClose={() => setSelection(null)}
                  onReplay={seek}
                />
              </div>
            )}
          </main>

          {/* The seam itself, and the only thing that draws the line between
              the picture and the panel. */}
          <TranscriptResizer
            side={layout.side}
            width={layout.width}
            onResize={resize}
            onReset={resetWidth}
            className={cn(!showSidebar && "hidden")}
          />

          {/* Hidden rather than unmounted, for the same reason the whole
              player is while the dictionary is up: the panel holds the search
              query, the translation toggle, and where the list is scrolled to,
              and putting the transcript away for a minute should not be a way
              of losing all three. */}
          <aside
            style={{ width: transcriptWidthCss(layout.width) }}
            className={cn("flex shrink-0 flex-col", !showSidebar && "hidden")}
          >
            <div className="min-h-0 flex-1">
              <TranscriptPanel
                analysis={analysis}
                activeSegmentIndex={activeSegmentIndex}
                selectedToken={selection?.token ?? null}
                hasApiKey={hasApiKey}
                subtitleTracks={video.subtitleTracks}
                externalSubtitles={video.externalSubtitles}
                side={layout.side}
                onSwapSide={swapSide}
                onHide={hide}
                onSeek={seek}
                onSelectWord={handleSelectWord}
                onOpenSettings={() => setIsSettingsOpen(true)}
              />
            </div>

            <div
              className={cn(
                "shrink-0 border-t border-border transition-[height]",
                selection ? "h-[22rem]" : "h-24",
              )}
            >
              <WordPanel
                selection={selection}
                onClose={() => setSelection(null)}
                onReplay={seek}
                onOpenDictionary={openDictionary}
              />
            </div>
          </aside>
        </div>
      </div>

      {/* Over the player, never instead of it. */}
      {isDictionaryOpen && (
        <VocabularyScreen initialLemma={dictionaryLemma} onClose={closeDictionary} />
      )}

      <SettingsDialog
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        settings={settings}
        appearance={appearance}
        colors={colorScheme}
        subtitles={subtitleStyle}
        playbackKeys={playbackKeys}
        theme={theme}
      />
    </>
  );
}

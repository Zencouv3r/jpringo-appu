"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as ipc from "@/lib/ipc";
import { RingoError } from "@/lib/ipc";
import { AUTO_TRANSCRIPT, transcriptChoiceKey } from "@/lib/types";
import type { Analysis, ProgressStage, TranscriptChoice } from "@/lib/types";

export type AnalysisStatus = "idle" | "loading" | "running" | "ready" | "error";

const WHISPER: TranscriptChoice = { kind: "whisper" };

/**
 * How long to wait before retrying a request the backend refused as busy.
 *
 * Only one run may hold a video at a time, and clicking through subtitle
 * tracks can land a request while the previous extraction is still finishing.
 * Reading a track takes about a second, so a couple of short retries turn what
 * would be a spurious error into a slightly slower switch.
 */
const BUSY_RETRY_MS = 400;
const BUSY_ATTEMPTS = 4;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `attempt` while the backend says another run holds this video. */
async function withBusyRetry<T>(
  attempt: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (cause) {
      const isBusy = cause instanceof RingoError && cause.kind === "busy";
      // Give up on the last try, and immediately if the caller has moved on —
      // retrying into a video the user has already left is pure waste.
      if (!isBusy || tries >= BUSY_ATTEMPTS || !isCurrent()) throw cause;
      await delay(BUSY_RETRY_MS);
    }
  }
}

/**
 * Whether a source can be built right now without asking permission.
 *
 * Reading a subtitle track is local, free, and takes about a second, so a
 * picked track loads itself — anything else means clicking a menu item and
 * watching nothing happen, which is what used to occur. Whisper is minutes of
 * CPU and is never started on the user's behalf.
 */
function loadsItself(choice: TranscriptChoice, hasSubtitles: boolean): boolean {
  switch (choice.kind) {
    case "embedded":
    case "external":
      return true;
    case "auto":
      return hasSubtitles;
    case "whisper":
      return false;
  }
}

/**
 * The transcript and breakdown for one video.
 *
 * The two halves are separate actions because they cost separate things.
 * Subtitle-backed transcripts appear on their own; whisper and the paid
 * breakdown each wait for a button. Progress arrives as Tauri events rather
 * than through a command's return value, which only resolves at the very end.
 *
 * `choice` selects which transcript source is active, and each choice is cached
 * separately on the Rust side, so switching between them never discards work
 * already paid for.
 */
export function useAnalysis(videoId: string | null, hasSubtitles: boolean) {
  const [choice, setChoiceState] = useState<TranscriptChoice>(AUTO_TRANSCRIPT);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>("idle");
  const [stage, setStage] = useState<ProgressStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped whenever a run is superseded, so a slow call that resolves after the
  // user moved on cannot write its result into the new state.
  const runRef = useRef(0);
  // The (session, video, choice) triple the loading effect has already acted
  // on. Without it, an action that switches choice *and* starts a run would
  // race the effect into starting a second one, which the backend refuses.
  const handledRef = useRef<string | null>(null);
  // Incremented on every video change, including back to one already open
  // before — closing a file and reopening it has to load again, which the key
  // alone cannot tell apart from a re-render.
  const [session, setSession] = useState(0);

  // Switching videos resets everything, adjusted during render rather than in
  // an effect so the previous file's transcript never paints under the new
  // file's title. The transcript choice resets too — a subtitle-track pick
  // made for one file has no meaning for another.
  const [loadedVideoId, setLoadedVideoId] = useState(videoId);
  if (loadedVideoId !== videoId) {
    setLoadedVideoId(videoId);
    setChoiceState(AUTO_TRANSCRIPT);
    setAnalysis(null);
    setStage(null);
    setError(null);
    setStatus(videoId ? "loading" : "idle");
    setSession((value) => value + 1);
  }

  /** Builds (or rebuilds) the transcript for one source. */
  const buildTranscript = useCallback(
    async (source: TranscriptChoice, force: boolean) => {
      if (!videoId) return;

      const run = ++runRef.current;
      setStatus("running");
      setError(null);
      setStage(null);

      try {
        const result = await withBusyRetry(
          () => ipc.startTranscript(videoId, source, force),
          () => runRef.current === run,
        );
        if (runRef.current !== run) return;
        setAnalysis(result);
        setStatus("ready");
        return result;
      } catch (cause) {
        if (runRef.current !== run) return;
        if (cause instanceof RingoError && cause.isCancelled) {
          setStatus("idle");
          return;
        }
        // "Auto found nothing" is the ordinary state of a file with only
        // English subtitles, not a failure — the empty panel already explains
        // what to do about it, and a red banner on every open would not.
        if (
          source.kind === "auto" &&
          cause instanceof RingoError &&
          cause.kind === "notFound"
        ) {
          setStatus("idle");
          return;
        }
        setError(cause instanceof Error ? cause.message : "Couldn't build a transcript.");
        setStatus("error");
      }
    },
    [videoId],
  );

  // Load whatever is cached for this video and choice, and build it when
  // building is free.
  useEffect(() => {
    if (!videoId) return;

    const key = `${session}|${videoId}|${transcriptChoiceKey(choice)}`;
    if (handledRef.current === key) return;
    handledRef.current = key;

    const run = ++runRef.current;
    void (async () => {
      setStatus("loading");
      setError(null);
      setStage(null);

      const cached = await ipc.getAnalysis(videoId, choice).catch(() => null);
      if (runRef.current !== run) return;

      if (cached) {
        setAnalysis(cached);
        setStatus("ready");
        return;
      }

      setAnalysis(null);
      if (!loadsItself(choice, hasSubtitles)) {
        setStatus("idle");
        return;
      }
      await buildTranscript(choice, false);
    })();
    // `choice` is a fresh object each render; the effect body keys on its
    // stable string form via `handledRef`, so re-running is harmless.
  }, [session, videoId, choice, hasSubtitles, buildTranscript]);

  // Resubscribing per video is cheap and lets the handler close over `videoId`
  // directly instead of reading it from a ref during render.
  useEffect(() => {
    if (!videoId) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void ipc
      .onProgress((event) => {
        if (event.videoId !== videoId) return;
        const { videoId: _ignored, ...rest } = event;
        void _ignored;
        setStage(rest as ProgressStage);
      })
      .then((fn) => {
        // The effect may have been torn down while `listen` was in flight.
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [videoId]);

  /**
   * Transcribes the audio with whisper — the only path that does, and only
   * ever from an explicit click. Switches the active source to match, so the
   * result is cached under whisper's own slot rather than overwriting a
   * subtitle transcript.
   */
  const transcribe = useCallback(
    async (force = false) => {
      if (!videoId) return;
      handledRef.current = `${session}|${videoId}|${transcriptChoiceKey(WHISPER)}`;
      setChoiceState(WHISPER);
      return buildTranscript(WHISPER, force);
    },
    [session, videoId, buildTranscript],
  );

  /** Rebuilds the current source from scratch. */
  const reload = useCallback(
    (force = true) => buildTranscript(choice, force),
    [choice, buildTranscript],
  );

  /**
   * Runs the paid passes: dictionary senses for words not already cached, then
   * the per-line translation and in-context breakdown. Always regenerates the
   * contextual half — its answers are only true of the lines they describe —
   * while the senses come from the vocabulary store for free.
   */
  const explain = useCallback(async () => {
    if (!videoId) return;

    const run = ++runRef.current;
    setStatus("running");
    setError(null);
    setStage(null);

    try {
      const result = await ipc.startBreakdown(videoId, choice);
      if (runRef.current !== run) return;
      setAnalysis(result);
      setStatus("ready");
      return result;
    } catch (cause) {
      if (runRef.current !== run) return;

      if (cause instanceof RingoError && cause.isCancelled) {
        // Cancelling is a user action, not a failure. Whatever finished was
        // cached — the transcript at minimum — so reload it rather than
        // discarding it.
        const partial = await ipc.getAnalysis(videoId, choice).catch(() => null);
        if (runRef.current !== run) return;
        setAnalysis(partial);
        setStatus(partial ? "ready" : "idle");
        return;
      }

      setError(cause instanceof Error ? cause.message : "The breakdown failed.");
      setStatus("error");
    }
  }, [videoId, choice]);

  const cancel = useCallback(async () => {
    if (!videoId) return;
    await ipc.cancelAnalysis(videoId);
  }, [videoId]);

  /** Discards the cached analysis for the current choice. */
  const reset = useCallback(async () => {
    if (!videoId) return;
    runRef.current++;
    handledRef.current = null;
    await ipc.removeAnalysis(videoId, choice);
    setAnalysis(null);
    setStatus("idle");
    setStage(null);
  }, [videoId, choice]);

  /**
   * Switches which transcript source is active. A run already in progress for
   * the old choice keeps running in the backend — cancel it first if that's
   * not wanted — but this hook stops listening for its result.
   */
  const setChoice = useCallback((next: TranscriptChoice) => {
    runRef.current++;
    setChoiceState(next);
  }, []);

  return {
    choice,
    setChoice,
    analysis,
    status,
    stage,
    error,
    transcribe,
    explain,
    reload,
    cancel,
    reset,
    isRunning: status === "running",
    /** Transcripts in other languages are readable, but nothing more. */
    isJapanese: analysis?.script === "japanese",
    /** A Japanese transcript exists but has no translations yet. */
    needsBreakdown: Boolean(analysis && !analysis.analyzed && analysis.script === "japanese"),
  };
}

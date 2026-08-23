"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as ipc from "@/lib/ipc";

/** How often the playback position is persisted for resume-on-reopen. */
const POSITION_SAVE_MS = 5000;

interface UsePlayerOptions {
  videoId: string | null;
  streamUrl: string | null;
  /** Duration from ffprobe. Authoritative — a live stream reports `Infinity`. */
  duration: number;
  /** True while the source is a live remux, where seeking restarts the stream. */
  seekIsApproximate: boolean;
  /** Resume point from the previous session. */
  initialPosition: number;
}

/**
 * Drives the `<video>` element.
 *
 * The wrinkle is seeking. A web-native file seeks by assigning `currentTime`.
 * A live remux cannot — the browser has no index for a stream ffmpeg is still
 * producing — so seeking means asking the server for a *new* stream starting
 * at the target offset. The element's clock then restarts from zero, and the
 * real position is `offset + element.currentTime`. `offsetRef` carries that
 * offset, and every timestamp this hook exposes already includes it, so
 * callers never have to care which mode is active.
 */
export function usePlayer({
  videoId,
  streamUrl,
  duration,
  seekIsApproximate,
  initialPosition,
}: UsePlayerOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const offsetRef = useRef(0);

  /**
   * Bumped whenever React hands over a *replacement* `<video>` element.
   *
   * The effects below wire up listeners and assign the source, and they have
   * to run again for a new element — which is what mounting the player again
   * produces, as happens whenever another screen has covered it. Keyed on the
   * URL alone they would leave the fresh element with no source and no
   * listeners: a player that looks normal, shows the position it had, and
   * does nothing at all.
   */
  const [attachment, setAttachment] = useState(0);
  /**
   * Whether an element has ever been attached.
   *
   * The first one needs no bump — the effects of the commit that mounted it
   * run against it already — and bumping anyway would assign the source a
   * second time, which on a live stream means starting a second ffmpeg and
   * dropping the first.
   */
  const hasAttachedRef = useRef(false);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(1);

  // A new file resets the clock. Adjusted during render so the previous
  // file's position never shows against the new one's title.
  const [loadedVideoId, setLoadedVideoId] = useState(videoId);
  if (loadedVideoId !== videoId) {
    setLoadedVideoId(videoId);
    setCurrentTime(0);
    setIsPlaying(false);
  }

  /**
   * Restores position across a source swap, or a change of element.
   *
   * Four cases land here: the initial load (resume where the user left off),
   * an audio-track change, the upgrade from live stream to remuxed file, and
   * the player being mounted again after another screen covered it. None of
   * them should visibly jump back to the beginning.
   */
  const pendingSeekRef = useRef<number | null>(null);
  /** Whether the swap interrupted playback, and so should resume it. */
  const resumePlayRef = useRef(false);
  useEffect(() => {
    if (!streamUrl) return;
    pendingSeekRef.current = currentTime > 0 ? currentTime : initialPosition;
    // Keyed on the source and the element, never on `currentTime` — this is
    // about the thing being played, or the thing playing it, being replaced;
    // including the clock would re-fire constantly. A new element with the
    // same source is the return-from-another-screen case, where the position
    // to restore is the one the old element had reached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, attachment]);

  const seek = useCallback(
    (time: number) => {
      const element = videoRef.current;
      if (!element) return;
      const target = Math.max(0, Math.min(time, duration || Infinity));

      if (seekIsApproximate && streamUrl) {
        // Restart the stream at the target. The offset is what keeps the
        // displayed time honest once the element's own clock resets.
        const wasPlaying = !element.paused;
        offsetRef.current = target;
        setCurrentTime(target);
        setIsBuffering(true);
        const separator = streamUrl.includes("?") ? "&" : "?";
        element.src = `${streamUrl}${separator}t=${target.toFixed(3)}`;
        element.load();
        if (wasPlaying) void element.play().catch(() => {});
      } else {
        element.currentTime = target;
        setCurrentTime(target);
      }
    },
    [duration, seekIsApproximate, streamUrl],
  );

  const play = useCallback(() => {
    void videoRef.current?.play().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  }, []);

  const skip = useCallback(
    (delta: number) => seek(currentTime + delta),
    [currentTime, seek],
  );

  const setVolume = useCallback((next: number) => {
    const element = videoRef.current;
    const clamped = Math.max(0, Math.min(1, next));
    if (element) {
      element.volume = clamped;
      // Nudging the slider off zero should also unmute, which is what the
      // control implies.
      if (clamped > 0 && element.muted) element.muted = false;
    }
    setVolumeState(clamped);
  }, []);

  const toggleMute = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setIsMuted(element.muted);
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    const element = videoRef.current;
    if (element) element.playbackRate = rate;
    setPlaybackRateState(rate);
  }, []);

  /**
   * Takes the `<video>` element.
   *
   * The ref is what the imperative callbacks above read; the state is what
   * the effects below key on. Both are needed: a ref alone cannot tell an
   * effect that the element it wired up has been replaced.
   */
  const attach = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    // Detaching needs nothing: the effects stay wired to an element that is on
    // its way out, and whatever replaces it arrives here in its own commit.
    if (!node) return;
    if (!hasAttachedRef.current) {
      hasAttachedRef.current = true;
      return;
    }
    setAttachment((count) => count + 1);
  }, []);

  /** Wires up element events. Re-runs on a new element or seeking mode. */
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    const onTimeUpdate = () => setCurrentTime(offsetRef.current + element.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => {
      setIsBuffering(false);
      setIsPlaying(true);
    };
    const onVolumeChange = () => {
      setVolumeState(element.volume);
      setIsMuted(element.muted);
    };
    const onLoadedMetadata = () => {
      setIsBuffering(false);
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      // Only meaningful for a real file; a live stream is already positioned
      // by its `t` parameter and its `currentTime` starts at zero regardless.
      if (pending && pending > 0 && !seekIsApproximate) {
        element.currentTime = pending;
        setCurrentTime(pending);
      }
      // Resumed here rather than straight after the swap so playback restarts
      // from the restored position instead of momentarily from the beginning.
      if (resumePlayRef.current) {
        resumePlayRef.current = false;
        void element.play().catch(() => {});
      }
    };
    const onEnded = () => setIsPlaying(false);
    // A source that cannot load never fires `loadedmetadata`, and leaving the
    // spinner up forever would claim it is still coming.
    const onError = () => {
      setIsBuffering(false);
      resumePlayRef.current = false;
    };

    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("waiting", onWaiting);
    element.addEventListener("playing", onPlaying);
    element.addEventListener("volumechange", onVolumeChange);
    element.addEventListener("loadedmetadata", onLoadedMetadata);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);

    return () => {
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("volumechange", onVolumeChange);
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
    };
  }, [attachment, streamUrl, seekIsApproximate]);

  /**
   * Points the element at the current source.
   *
   * Assigned here rather than as a `src` prop on the element because a swap
   * has to carry the playback position with it, and on a live stream that
   * position *is* part of the URL. Rendering `src={streamUrl}` instead would
   * restart the episode from zero every time the user changed audio track.
   *
   * Declared after the listener effect above so the element is already wired
   * up before it starts loading, and so `offsetRef` is set for the source that
   * is about to play rather than the one being replaced.
   */
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !streamUrl) return;

    const resume = pendingSeekRef.current ?? 0;
    resumePlayRef.current = !element.paused;
    setIsBuffering(true);

    if (seekIsApproximate && resume > 0) {
      // A stream can only start where ffmpeg is told to start it, so the
      // resume point goes into the URL and `offsetRef` carries it back into
      // every timestamp this hook reports. `pendingSeekRef` is left for
      // `loadedmetadata` to clear rather than consumed here, which keeps this
      // effect idempotent — StrictMode runs it twice on mount, and a second
      // pass reading a cleared ref would reload the source back at zero.
      offsetRef.current = resume;
      setCurrentTime(resume);
      const separator = streamUrl.includes("?") ? "&" : "?";
      element.src = `${streamUrl}${separator}t=${resume.toFixed(3)}`;
    } else {
      // A seekable source has an absolute timeline, so the offset drops back
      // to zero and `loadedmetadata` restores the position by assignment.
      offsetRef.current = 0;
      element.src = streamUrl;
    }

    element.load();
  }, [attachment, streamUrl, seekIsApproximate]);

  // Persist the position on a timer and once more on unmount, so closing the
  // app mid-episode still resumes correctly.
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (!videoId) return;

    const persist = () => {
      const position = currentTimeRef.current;
      if (position > 0) void ipc.savePosition(videoId, position).catch(() => {});
    };

    const timer = setInterval(persist, POSITION_SAVE_MS);
    return () => {
      clearInterval(timer);
      persist();
    };
  }, [videoId]);

  return {
    attach,
    videoRef,
    currentTime,
    duration,
    isPlaying,
    isBuffering,
    volume,
    isMuted,
    playbackRate,
    play,
    pause,
    togglePlay,
    seek,
    skip,
    setVolume,
    toggleMute,
    setPlaybackRate,
  };
}

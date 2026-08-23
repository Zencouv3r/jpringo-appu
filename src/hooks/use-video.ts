"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as ipc from "@/lib/ipc";
import type { OpenedVideo } from "@/lib/types";

/** How often to check whether the background remux has finished. */
const UPGRADE_POLL_MS = 4000;

/**
 * The currently open video.
 *
 * Also handles the seeking upgrade: a file that needs remuxing starts on a live
 * ffmpeg stream, which plays immediately but can only "seek" by restarting
 * itself. When the background remux finishes, Rust starts returning a URL for
 * the finished MP4 and this swaps to it, at which point seeking becomes exact.
 * The swap is invisible apart from the player briefly rebuffering.
 */
export function useVideo() {
  const [video, setVideo] = useState<OpenedVideo | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow open resolving after the user has already opened
  // something else, which would otherwise clobber the newer selection.
  const requestRef = useRef(0);

  const open = useCallback(async (path: string) => {
    const request = ++requestRef.current;
    setIsOpening(true);
    setError(null);
    try {
      const opened = await ipc.openVideo(path);
      if (requestRef.current !== request) return null;
      setVideo(opened);
      return opened;
    } catch (cause) {
      if (requestRef.current !== request) return null;
      setError(cause instanceof Error ? cause.message : "Couldn't open that file.");
      return null;
    } finally {
      if (requestRef.current === request) setIsOpening(false);
    }
  }, []);

  const openWithPicker = useCallback(async () => {
    const path = await ipc.pickVideoFile();
    return path ? open(path) : null;
  }, [open]);

  const close = useCallback(() => {
    requestRef.current++;
    setVideo(null);
    setError(null);
  }, []);

  /**
   * Switches audio track.
   *
   * The backend always answers with a *live* stream immediately, so the swap
   * feels instant even though the exact-seek version (if background remuxing
   * is on) is still being built. `seekIsApproximate` is inferred from the URL
   * shape rather than asked for separately: a `/stream` URL is always
   * approximate, a `/media/{id}` URL is always exact — see
   * `media::server::MediaRegistry::url_for` on the Rust side.
   */
  const switchAudioTrack = useCallback(async (audioTrack: number | null) => {
    const current = video;
    if (!current) return;

    const request = ++requestRef.current;
    try {
      const url = await ipc.switchAudioTrack(current.id, audioTrack);
      if (requestRef.current !== request) return;
      setVideo((existing) =>
        existing && existing.id === current.id
          ? {
              ...existing,
              streamUrl: url,
              audioTrack,
              seekIsApproximate: url.includes("/stream?"),
            }
          : existing,
      );
    } catch (cause) {
      if (requestRef.current !== request) return;
      setError(cause instanceof Error ? cause.message : "Couldn't switch audio track.");
    }
  }, [video]);

  const videoId = video?.id;
  const needsUpgrade = video?.seekIsApproximate ?? false;

  useEffect(() => {
    if (!videoId || !needsUpgrade) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const url = await ipc.exactStreamUrl(videoId);
        if (cancelled || !url) return;
        setVideo((current) =>
          current && current.id === videoId
            ? { ...current, streamUrl: url, seekIsApproximate: false }
            : current,
        );
      } catch {
        // The remux may still be running, or may have failed — either way the
        // live stream keeps working, so there is nothing to surface.
      }
    }, UPGRADE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [videoId, needsUpgrade]);

  return { video, isOpening, error, open, openWithPicker, close, switchAudioTrack };
}

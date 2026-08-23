"use client";

import { useCallback, useEffect, useState } from "react";

import * as ipc from "@/lib/ipc";
import type { RecentEntry } from "@/lib/types";

/**
 * The recently-opened list.
 *
 * Rust re-checks each entry against disk on every read, so `refresh` is also
 * how the UI learns that a file has been moved or deleted.
 */
export function useLibrary() {
  const [entries, setEntries] = useState<RecentEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setEntries(await ipc.listRecent());
    } catch {
      // A missing or unreadable library file is not worth an error state —
      // an empty list is indistinguishable from a first run.
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Inlined rather than calling `refresh()` directly: the state updates have
  // to land in an async continuation, not synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await ipc.listRecent();
        if (!cancelled) setEntries(list);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = useCallback(async (videoId: string) => {
    // Optimistic: removing from a list is trivially reversible by reopening
    // the file, and waiting on a disk write makes the click feel laggy.
    setEntries((current) => current.filter((entry) => entry.id !== videoId));
    await ipc.removeRecent(videoId);
  }, []);

  const clear = useCallback(async () => {
    setEntries([]);
    await ipc.clearRecent();
  }, []);

  return { entries, isLoading, refresh, remove, clear };
}

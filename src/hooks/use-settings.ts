"use client";

import { useCallback, useEffect, useState } from "react";

import * as ipc from "@/lib/ipc";
import type { Settings, SettingsView } from "@/lib/types";

/**
 * Loads settings once and keeps the local copy in sync with every write.
 *
 * Rust is the source of truth — it clamps values and recomputes derived facts
 * like `modelAvailable` — so each mutation returns the authoritative view and
 * we store that rather than what we optimistically sent.
 */
export function useSettings() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await ipc.getSettings());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load settings.");
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
        const loaded = await ipc.getSettings();
        if (!cancelled) {
          setSettings(loaded);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Couldn't load settings.",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: Settings) => {
    const updated = await ipc.saveSettings(next);
    setSettings(updated);
    return updated;
  }, []);

  /** Saves a partial change without the caller reassembling the whole object. */
  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!settings) return;
      const {
        hasApiKey,
        resolvedModelPath,
        modelAvailable,
        gpuAvailable,
        cacheBytes,
        vocabularyWords,
        resolvedDataDir,
        defaultDataDir,
        dataDirAvailable,
        ...current
      } = settings;
      void hasApiKey;
      void resolvedModelPath;
      void modelAvailable;
      void gpuAvailable;
      void cacheBytes;
      void vocabularyWords;
      void resolvedDataDir;
      void defaultDataDir;
      void dataDirAvailable;
      return save({ ...current, ...patch });
    },
    [settings, save],
  );

  const setApiKey = useCallback(async (key: string | null) => {
    const hasApiKey = await ipc.setApiKey(key);
    setSettings((current) => (current ? { ...current, hasApiKey } : current));
    return hasApiKey;
  }, []);

  const clearCache = useCallback(async () => {
    const cacheBytes = await ipc.clearCache();
    setSettings((current) => (current ? { ...current, cacheBytes } : current));
    return cacheBytes;
  }, []);

  /** Empties the word log — encounters and the definitions paid for with them. */
  const clearVocabulary = useCallback(async () => {
    const vocabularyWords = await ipc.clearVocabulary();
    setSettings((current) => (current ? { ...current, vocabularyWords } : current));
    return vocabularyWords;
  }, []);

  return {
    settings,
    isLoading,
    error,
    refresh,
    save,
    update,
    setApiKey,
    clearCache,
    clearVocabulary,
  };
}

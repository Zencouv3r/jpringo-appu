"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as ipc from "@/lib/ipc";
import { DEFAULT_VOCAB_QUERY } from "@/lib/types";
import type {
  KanjiDetail,
  KanjiStat,
  VocabPage,
  VocabQuery,
  VocabSourceSummary,
} from "@/lib/types";

/**
 * Typing settles before the list re-queries. Rust answers from memory in about
 * a millisecond, so this is purely about not repainting a 100-row list on
 * every keystroke.
 */
const SEARCH_DEBOUNCE_MS = 120;

/**
 * The vocabulary log, filtered and sorted by Rust.
 *
 * Filtering happens on the Rust side rather than over a downloaded copy of the
 * log: it already holds the whole thing in memory, and shipping ten thousand
 * entries into the webview to filter them here would be slower and would put a
 * second, staler copy of the data in play.
 */
export function useVocabulary(initialSearch = "") {
  const [query, setQuery] = useState<VocabQuery>({
    ...DEFAULT_VOCAB_QUERY,
    search: initialSearch,
  });
  const [page, setPage] = useState<VocabPage | null>(null);
  const [sources, setSources] = useState<VocabSourceSummary[]>([]);
  const [kanji, setKanji] = useState<KanjiStat[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards against an earlier query resolving after a later one.
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const timer = setTimeout(() => {
      setIsLoading(true);
      void (async () => {
        try {
          const result = await ipc.listWords(query);
          if (requestRef.current !== request) return;
          setPage(result);
          setError(null);
        } catch (cause) {
          if (requestRef.current !== request) return;
          setError(cause instanceof Error ? cause.message : "Couldn't read the word log.");
        } finally {
          if (requestRef.current === request) setIsLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // The filter menus and the kanji list change only when a video is analyzed,
  // so they load once per visit rather than per query.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [loadedSources, loadedKanji] = await Promise.all([
        ipc.listWordSources().catch(() => []),
        ipc.listKanji(0).catch(() => []),
      ]);
      if (cancelled) return;
      setSources(loadedSources);
      setKanji(loadedKanji);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Merges a change into the query. Any change other than paging resets to the
   * first page — staying on page four of a filter that now has two pages shows
   * an empty list for no visible reason.
   */
  const update = useCallback((patch: Partial<VocabQuery>) => {
    setQuery((current) => ({
      ...current,
      ...patch,
      offset: patch.offset ?? 0,
    }));
  }, []);

  const reset = useCallback(() => setQuery(DEFAULT_VOCAB_QUERY), []);

  return { query, update, reset, page, sources, kanji, isLoading, error };
}

/**
 * The panel beside the kanji grid.
 *
 * Fetched per character rather than shipped with the grid: the detail carries
 * every word using the character and the readings aligned out of them, which
 * for a few hundred kanji would be most of the log sent across for the one
 * card that ends up being clicked.
 */
export function useKanjiDetail(character: string | null) {
  // The character is stored *with* the answer, which is what lets both values
  // below be derived rather than synced: an answer for the previous character
  // is not this character's answer, it is this character still loading.
  const [loaded, setLoaded] = useState<{
    character: string;
    detail: KanjiDetail | null;
  } | null>(null);

  useEffect(() => {
    if (!character) return;

    let cancelled = false;
    void (async () => {
      const detail = await ipc.getKanji(character).catch(() => null);
      if (!cancelled) setLoaded({ character, detail });
    })();

    return () => {
      cancelled = true;
    };
  }, [character]);

  const isCurrent = loaded !== null && loaded.character === character;
  return {
    detail: isCurrent ? loaded.detail : null,
    isLoading: character !== null && !isCurrent,
  };
}

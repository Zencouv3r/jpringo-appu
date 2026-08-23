"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How long the hint stays up after entering fullscreen.
 *
 * Long enough to be read by someone whose attention is on the picture, short
 * enough that it is gone before it becomes furniture. Pressing the key
 * dismisses it early, since at that point it has said everything it knows.
 */
const HINT_MS = 10_000;

/**
 * How long the interface stays up after the mouse stops moving.
 *
 * Long enough to cross the screen to a control without it vanishing on the
 * way, short enough that a nudge of the mouse doesn't undo the hiding for the
 * rest of the episode.
 */
const REVEAL_MS = 2500;

/**
 * Marks the parts of the interface this hook hides.
 *
 * A pointer resting on the control bar has to keep it up — otherwise the bar
 * disappears out from under the click that was about to land on it — and the
 * cheapest way to know the pointer is over a control is to ask the element
 * under it. Spread onto the header and the control bar.
 */
export const CHROME_PROPS = { "data-player-chrome": "" } as const;

const CHROME_SELECTOR = "[data-player-chrome]";

/**
 * Fullscreen with nothing but the picture in it.
 *
 * Fullscreen is the mode the subtitles exist for, and a title bar and a
 * control bar are two rows of interface between the viewer and the thing they
 * went fullscreen to see. `h` puts them away; moving the mouse brings them
 * back for as long as the mouse is being used, so hiding them never means
 * losing them.
 *
 * Only ever active in fullscreen. Windowed, the header is the app's own
 * furniture — the Library button, the file name, Settings — and hiding it
 * would leave a window with no way out of itself.
 */
export function useImmersive(isFullscreen: boolean) {
  /** Whether the viewer has asked for the interface to be out of the way. */
  const [isHiding, setIsHiding] = useState(false);
  /** Whether the mouse has since woken it up again. */
  const [isRevealed, setIsRevealed] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Entering fullscreen offers the hint; leaving puts the interface back,
  // because a windowed player with no controls is a bug report.
  //
  // Adjusted during render rather than in an effect, so a frame of the old
  // mode never paints in the new one — the same pattern as the rest of the
  // app. See https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [wasFullscreen, setWasFullscreen] = useState(isFullscreen);
  if (wasFullscreen !== isFullscreen) {
    setWasFullscreen(isFullscreen);
    setIsHiding(false);
    setIsRevealed(false);
    setShowHint(isFullscreen);
  }

  // The hint's few seconds. This effect only ever *clears* it, and only from
  // the timer.
  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(() => setShowHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [showHint]);

  const toggle = useCallback(() => {
    if (!isFullscreen) return;
    setShowHint(false);
    setIsRevealed(false);
    setIsHiding((value) => !value);
  }, [isFullscreen]);

  useEffect(() => {
    if (!isHiding) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onMove = (event: MouseEvent) => {
      setIsRevealed(true);
      clearTimeout(timer);
      // A pointer that has come to rest *on* a control keeps it up
      // indefinitely; one over the picture starts the countdown again.
      const target = event.target as Element | null;
      if (target?.closest?.(CHROME_SELECTOR)) return;
      timer = setTimeout(() => setIsRevealed(false), REVEAL_MS);
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      clearTimeout(timer);
    };
  }, [isHiding]);

  return {
    /** True while the header and the control bar should be off the screen. */
    isHidden: isHiding && !isRevealed,
    /** True while the hint above the picture should be showing. */
    showHint,
    /** Bound to `h` and to the button in the control bar. */
    toggle,
  };
}

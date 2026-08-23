"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Keys that move a slider. Tab and Escape are not adjustments. */
const ADJUST_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * "Get out of the way while I drag this."
 *
 * Picking an interface colour has an obvious problem: the control that changes
 * it is sitting on top of the thing it changes. A dialog is opaque, centred,
 * and covering exactly the transcript, the buttons, and the borders whose
 * colour is being chosen — so the effect of every drag is invisible until the
 * dialog is dismissed, which is after the moment the decision gets made.
 *
 * So the dialog gets out of the way for the length of the drag and comes
 * straight back. It stays interactive throughout: fading is a visual change,
 * not a modal one, and a pointer that has captured a slider thumb keeps it
 * whatever the opacity says.
 *
 * The release is a *window* listener rather than the slider's own pointerup,
 * because a drag routinely ends somewhere else entirely — off the thumb, off
 * the dialog, outside the window. Missing that event would leave the interface
 * stuck at a fraction of its opacity with no obvious way back, which is a
 * worse failure than never fading at all.
 */
export function useLivePreview() {
  const [isPreviewing, setIsPreviewing] = useState(false);
  // Read by the listener below, so switching mode never re-subscribes.
  const untilPointerUp = useRef(false);

  useEffect(() => {
    if (!isPreviewing) return;
    const stop = () => {
      if (untilPointerUp.current) setIsPreviewing(false);
    };
    // All three in the capture phase, which is the whole point of putting them
    // on `window`: capture runs top-down before anything else sees the event,
    // so a slider that stops propagation on its own pointerup — a reasonable
    // thing for a drag primitive to do — cannot strand the dialog at 40%.
    //
    // `pointercancel` covers a drag the OS interrupts: a touch turning into a
    // scroll, or the window losing the pointer to something else.
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    // A keyboard-driven slider never sends a pointerup at all. Holding the key
    // repeats keydown without a keyup, so a held adjustment stays faded.
    window.addEventListener("keyup", stop, true);
    return () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("keyup", stop, true);
    };
  }, [isPreviewing]);

  /** Fade until the pointer comes back up, or the key is released. */
  const beginDrag = useCallback(() => {
    untilPointerUp.current = true;
    setIsPreviewing(true);
  }, []);

  /** Fade until {@link release} is called — for controls with no drag to end. */
  const hold = useCallback(() => {
    untilPointerUp.current = false;
    setIsPreviewing(true);
  }, []);

  const release = useCallback(() => {
    untilPointerUp.current = false;
    setIsPreviewing(false);
  }, []);

  /**
   * Spread onto whatever wraps a slider.
   *
   * Capture-phase, to match the release listeners above: the press lands on
   * the slider's own thumb or track, and this has to see it whether or not
   * that element lets the event carry on upwards.
   */
  const dragProps = useMemo(
    () => ({
      onPointerDownCapture: () => beginDrag(),
      onKeyDownCapture: (event: React.KeyboardEvent) => {
        if (ADJUST_KEYS.has(event.key)) beginDrag();
      },
    }),
    [beginDrag],
  );

  return { isPreviewing, beginDrag, hold, release, dragProps };
}

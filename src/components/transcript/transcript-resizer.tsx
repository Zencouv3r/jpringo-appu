"use client";

import { useEffect, useRef, useState } from "react";

import {
  MIN_VIDEO_WIDTH,
  TRANSCRIPT_WIDTH_RANGE,
  rootFontSizePx,
  type TranscriptSide,
} from "@/lib/layout";
import { cn } from "@/lib/utils";

/** How far one arrow-key press moves the divider, in rem. */
const KEY_STEP = 1;

interface Drag {
  pointerId: number;
  /**
   * Where inside the divider the pointer took hold, in pixels. Subtracting it
   * keeps the edge under the cursor for the whole drag instead of jumping the
   * width of the handle on the first move.
   */
  grab: number;
  /** The row's edges, measured once: they cannot change mid-drag. */
  rowLeft: number;
  rowRight: number;
  rootPx: number;
  /** The widest the transcript may go without starving the video. */
  max: number;
}

interface TranscriptResizerProps {
  side: TranscriptSide;
  /** The stored width in rem, for the arrow keys and the accessible value. */
  width: number;
  /** Given a width in rem and the ceiling measured from the live container. */
  onResize: (width: number, max: number) => void;
  /** Double-click: back to the default split. */
  onReset: () => void;
  className?: string;
}

/**
 * The draggable edge between the video and the transcript.
 *
 * A real flex item rather than a bar floating over the seam, which is what
 * keeps it out of the way of everything either side of it — the transcript's
 * scrollbar sits against this edge when the panel is on the left, and an
 * overlay wide enough to grab comfortably would eat part of it.
 *
 * Widths are computed from the pointer's distance to the *far* edge of the
 * row rather than from a running delta, so a drag that hits the clamp and
 * comes back tracks the cursor instead of drifting away from it.
 */
export function TranscriptResizer({
  side,
  width,
  onResize,
  onReset,
  className,
}: TranscriptResizerProps) {
  const [isResizing, setIsResizing] = useState(false);
  const drag = useRef<Drag | null>(null);

  // The cursor and the selection are the whole window's problem during a
  // drag: the pointer spends most of it over the video, whose own cursor
  // would otherwise flicker back, and a fast drag across the transcript
  // would select every line it crossed.
  useEffect(() => {
    if (!isResizing) return;
    const { body } = document;
    const cursor = body.style.cursor;
    const select = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      body.style.cursor = cursor;
      body.style.userSelect = select;
    };
  }, [isResizing]);

  /** The ceiling right now, in rem — the row's width less the video's floor. */
  const ceiling = (handle: HTMLElement, rootPx: number): number => {
    const row = handle.parentElement;
    if (!row) return TRANSCRIPT_WIDTH_RANGE.max;
    return Math.min(
      TRANSCRIPT_WIDTH_RANGE.max,
      row.getBoundingClientRect().width / rootPx - MIN_VIDEO_WIDTH,
    );
  };

  /** Distance from the pointer to the row edge the transcript is anchored to. */
  const reach = (clientX: number, rowLeft: number, rowRight: number): number =>
    side === "right" ? rowRight - clientX : clientX - rowLeft;

  return (
    <div
      // The window-splitter pattern: a focusable separator carrying the width
      // it controls, so the divider is not mouse-only.
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the transcript"
      aria-valuenow={Math.round(width)}
      aria-valuemin={TRANSCRIPT_WIDTH_RANGE.min}
      aria-valuemax={TRANSCRIPT_WIDTH_RANGE.max}
      tabIndex={0}
      data-resizing={isResizing || undefined}
      className={cn(
        "group relative w-[5px] shrink-0 cursor-col-resize touch-none transition-colors outline-none",
        "hover:bg-primary/40 focus-visible:bg-primary/40 data-[resizing]:bg-primary/60",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const handle = event.currentTarget;
        const row = handle.parentElement;
        if (!row) return;

        const rowRect = row.getBoundingClientRect();
        const handleRect = handle.getBoundingClientRect();
        const rootPx = rootFontSizePx();
        // What the panel is actually showing, which is not always what is
        // stored: a window narrow enough for the CSS clamp to bite renders it
        // smaller. Grabbing the rendered edge is what the user sees.
        const panelPx = reach(
          side === "right" ? handleRect.right : handleRect.left,
          rowRect.left,
          rowRect.right,
        );

        drag.current = {
          pointerId: event.pointerId,
          grab: reach(event.clientX, rowRect.left, rowRect.right) - panelPx,
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rootPx,
          max: ceiling(handle, rootPx),
        };
        handle.setPointerCapture(event.pointerId);
        setIsResizing(true);
        // Otherwise the press starts a text selection in whatever it lands on
        // — which also costs the divider the focus it would have got, so it
        // takes it back by hand and the arrow keys carry on from where the
        // drag left off.
        event.preventDefault();
        handle.focus();
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        const pointer = reach(event.clientX, current.rowLeft, current.rowRight);
        onResize((pointer - current.grab) / current.rootPx, current.max);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
        setIsResizing(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setIsResizing(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        // Left always moves the divider left, whichever side the transcript
        // is on — which is to say it grows the panel on the right and shrinks
        // the one on the left.
        const towardsLeft =
          event.key === "ArrowLeft" ? true : event.key === "ArrowRight" ? false : null;
        if (towardsLeft === null) return;
        event.preventDefault();
        // The player listens for the arrows on the window, where they scrub.
        // While the divider has the focus they are the divider's, so the
        // event stops here rather than also jumping the video five seconds.
        // Every other key is left alone and carries on to the player.
        event.stopPropagation();

        const grows = towardsLeft === (side === "right");
        const rootPx = rootFontSizePx();
        onResize(
          width + (grows ? KEY_STEP : -KEY_STEP),
          ceiling(event.currentTarget, rootPx),
        );
      }}
    >
      {/* The hairline the panel used to draw as a border. It stays put while
          the strip around it tints, so the seam never moves. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors",
          "group-hover:bg-transparent group-data-[resizing]:bg-transparent",
        )}
      />
    </div>
  );
}

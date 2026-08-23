"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn, formatTimestamp } from "@/lib/utils";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  /** Marks where transcript lines start, so dialogue is visible in the bar. */
  markers?: number[];
  className?: string;
}

/**
 * The scrubber.
 *
 * Hand-built rather than a range input or the shared `Slider`, because a video
 * scrubber needs three things those don't give: a hover preview of the target
 * timestamp, tick marks for dialogue, and a drag that updates the displayed
 * position continuously while only committing the seek on release. Seeking on
 * every pointer move would restart the ffmpeg stream dozens of times per drag.
 */
export function SeekBar({
  currentTime,
  duration,
  onSeek,
  markers,
  className,
}: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const timeFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return 0;
      const { left, width } = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
      return ratio * duration;
    },
    [duration],
  );

  // While dragging, show the dragged position rather than the element's.
  const displayTime = dragTime ?? currentTime;
  const progress = duration > 0 ? Math.min(1, displayTime / duration) : 0;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragTime(timeFromEvent(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const time = timeFromEvent(event.clientX);
    setHoverTime(time);
    if (dragTime !== null) setDragTime(time);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragTime === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onSeek(timeFromEvent(event.clientX));
    setDragTime(null);
  };

  // A drag that ends outside the window never fires pointerup on the track.
  useEffect(() => {
    if (dragTime === null) return;
    const onCancel = () => setDragTime(null);
    window.addEventListener("pointercancel", onCancel);
    return () => window.removeEventListener("pointercancel", onCancel);
  }, [dragTime]);

  const previewTime = dragTime ?? hoverTime;

  return (
    <div className={cn("group/seek relative w-full", className)}>
      {previewTime !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 rounded-[1.5px] bg-popover px-1.5 py-0.5 text-xs tabular-nums text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{ left: `${Math.min(100, Math.max(0, (previewTime / duration) * 100))}%` }}
        >
          {formatTimestamp(previewTime)}
        </div>
      )}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.floor(duration))}
        aria-valuenow={Math.floor(displayTime)}
        aria-valuetext={formatTimestamp(displayTime)}
        className="relative flex h-5 cursor-pointer touch-none items-center outline-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHoverTime(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onSeek(Math.max(0, currentTime - 5));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onSeek(Math.min(duration, currentTime + 5));
          }
        }}
      >
        <div className="relative h-1 w-full rounded-full bg-white/25 transition-[height] group-hover/seek:h-1.5">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-primary"
            style={{ width: `${progress * 100}%` }}
          />

          {markers && duration > 0 && (
            <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/seek:opacity-100">
              {markers.map((time, index) => (
                <span
                  key={index}
                  className="absolute top-1/2 size-0.5 -translate-y-1/2 rounded-full bg-white/70"
                  style={{ left: `${(time / duration) * 100}%` }}
                />
              ))}
            </div>
          )}
        </div>

        <div
          className="pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity group-hover/seek:opacity-100"
          style={{ left: `${progress * 100}%`, opacity: dragTime !== null ? 1 : undefined }}
        />
      </div>
    </div>
  );
}

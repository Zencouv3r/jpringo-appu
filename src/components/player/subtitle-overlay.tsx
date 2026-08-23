"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { WordSelection } from "@/components/word/word-panel";
import {
  TEXT_SHADOW,
  backgroundColor,
  type Position,
  type SubtitleStyle,
  type SubtitleTrackKey,
  type SubtitleTrackStyle,
} from "@/lib/subtitle-style";
import { isSelectedToken, splitIntoPieces } from "@/lib/tokens";
import type { Segment, Token } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * How far the pointer may travel before a press counts as a drag rather than
 * a click. Below this, clicking a word still selects it; above it, the click
 * that ends the drag is swallowed so the word doesn't open by accident.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * Stand-in text shown while the appearance menu is open.
 *
 * Without it, a block can only be dragged during a line — pause in a silence
 * to tidy the layout and there is nothing on screen to take hold of. The
 * placeholder also says what to do with itself.
 */
const PREVIEW_JAPANESE = "ドラッグで字幕の位置を調整";
const PREVIEW_TRANSLATION = "Drag either line to place it";

interface SubtitleOverlayProps {
  /** The line currently being spoken, or `null` between lines. */
  segment: Segment | null;
  style: SubtitleStyle;
  selection: WordSelection | null;
  onSelectWord: (token: Token, segment: Segment) => void;
  onMove: (track: SubtitleTrackKey, position: Position) => void;
  /** True while the appearance menu is open: show both blocks regardless. */
  isAdjusting: boolean;
  /** Jumps to the start of the line `delta` places away in the transcript. */
  onStepLine: (delta: number) => void;
  canStepBack: boolean;
  canStepForward: boolean;
}

/** The arrows flanking a subtitle, and what they can currently do. */
interface StepControls {
  onStep: (delta: number) => void;
  canStepBack: boolean;
  canStepForward: boolean;
}

/**
 * The transcript, drawn over the video as subtitles.
 *
 * Two independent blocks — the Japanese line and its translation — each with
 * its own size, colour, and position, because they are read differently: the
 * Japanese is what you are studying and the translation is the safety net you
 * glance at. Both are draggable, since where subtitles belong depends on what
 * the video puts behind them.
 *
 * The words are the same words as in the transcript panel: same tokenizer,
 * same click, same word panel. A learner watching fullscreen shouldn't have to
 * come back to the sidebar to look something up.
 */
export function SubtitleOverlay({
  segment,
  style,
  selection,
  onSelectWord,
  onMove,
  isAdjusting,
  onStepLine,
  canStepBack,
  canStepForward,
}: SubtitleOverlayProps) {
  if (!style.enabled) return null;

  const hasLine = Boolean(segment && segment.text.trim());
  const hasTranslation = Boolean(segment && segment.translation.trim());
  const showJapanese = style.japanese.enabled && (hasLine || isAdjusting);
  const showTranslation = style.translation.enabled && (hasTranslation || isAdjusting);
  if (!showJapanese && !showTranslation) return null;

  // One pair of arrows, on whichever block is on top. Two pairs would be two
  // controls for one action, and stepping is a property of the line rather
  // than of either rendering of it.
  const steps: StepControls = { onStep: onStepLine, canStepBack, canStepForward };

  return (
    // Transparent to the pointer as a whole, so clicking the picture still
    // pauses; only the blocks themselves take events.
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {showJapanese && (
        <SubtitleBlock
          track="japanese"
          style={style.japanese}
          onMove={onMove}
          steps={steps}
          // Loose leading and a touch of letter-spacing: Japanese set at
          // subtitle size runs together otherwise, and the whole point is to
          // be able to pick out individual words.
          className="leading-relaxed tracking-wide"
        >
          {segment && hasLine ? (
            splitIntoPieces(segment).map((piece, index) => {
              const token = piece.token;
              if (!token?.clickable) {
                return <span key={index}>{piece.text}</span>;
              }
              return (
                <WordButton
                  key={index}
                  text={piece.text}
                  token={token}
                  isSelected={isSelectedToken(token, segment, selection)}
                  onSelect={() => onSelectWord(token, segment)}
                />
              );
            })
          ) : (
            <span className="opacity-70">{PREVIEW_JAPANESE}</span>
          )}
        </SubtitleBlock>
      )}

      {showTranslation && (
        <SubtitleBlock
          track="translation"
          style={style.translation}
          onMove={onMove}
          steps={showJapanese ? undefined : steps}
          className="leading-snug"
        >
          {segment && hasTranslation ? (
            segment.translation
          ) : (
            <span className="opacity-70">{PREVIEW_TRANSLATION}</span>
          )}
        </SubtitleBlock>
      )}
    </div>
  );
}

/**
 * One positioned, draggable block.
 *
 * Position is the block's centre as a fraction of the video area, so a resize
 * or a jump to fullscreen keeps it proportionally where it was put rather than
 * pinned to a pixel that now means something else.
 */
function SubtitleBlock({
  track,
  style,
  onMove,
  steps,
  className,
  children,
}: {
  track: SubtitleTrackKey;
  style: SubtitleTrackStyle;
  onMove: (track: SubtitleTrackKey, position: Position) => void;
  /** Present on the block that carries the previous/next line arrows. */
  steps?: StepControls;
  className?: string;
  children: React.ReactNode;
}) {
  const [isDragging, setIsDragging] = useState(false);
  // Written during the drag and read by the click handler in the same gesture,
  // so it has to be a ref: a state update would not have landed by then.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Position;
    bounds: DOMRect;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; a right-click should do nothing at all
    // rather than leave the block stuck to the cursor.
    if (event.button !== 0) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;

    // Clear any suppression left over from a drag whose click never arrived,
    // which would otherwise swallow this press's click instead.
    suppressClickRef.current = false;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: style.position,
      bounds: container.getBoundingClientRect(),
      moved: false,
    };
    // Deliberately *not* capturing yet. Pointer capture retargets the
    // compatibility mouse events too, so capturing here would make the click
    // land on this block instead of the word button the press started on —
    // every word click would silently do nothing. Capture begins in
    // `onPointerMove`, once the gesture is known to be a drag.
  }, [style.position]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        setIsDragging(true);
        // Now that this is a drag, capture: the block moves out from under the
        // cursor immediately, and without capture the very next move would be
        // delivered to whatever is underneath instead.
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      onMove(track, {
        x: drag.origin.x + dx / drag.bounds.width,
        y: drag.origin.y + dy / drag.bounds.height,
      });
    },
    [onMove, track],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // A press that moved is a drag, and the click browsers synthesize at the
    // end of it must not also select whatever word it happens to land on.
    suppressClickRef.current = drag.moved;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      // `absolute` inside the overlay, positioned by its centre.
      style={{
        left: `${style.position.x * 100}%`,
        top: `${style.position.y * 100}%`,
        transform: "translate(-50%, -50%)",
        maxWidth: `${style.maxWidth * 100}%`,
        fontSize: `${style.fontSize}px`,
        color: style.color,
        backgroundColor: backgroundColor(style.background),
        textShadow: TEXT_SHADOW,
      }}
      className={cn(
        "pointer-events-auto absolute flex items-center gap-[0.15em] rounded-[1.5px] px-2 py-1 text-center break-words touch-none select-none",
        // Grabbable everywhere except on a word, which keeps its pointer.
        isDragging ? "cursor-grabbing ring-2 ring-white/40" : "cursor-grab",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onClickCapture}
    >
      {steps && (
        <StepButton
          direction={-1}
          disabled={!steps.canStepBack}
          onStep={steps.onStep}
        />
      )}
      {/* The text is a flex item so the arrows sit beside it rather than over
          it: a chevron overlapping the first character of a line would be
          unreadable exactly when the line is longest. */}
      <span className="min-w-0 flex-1">{children}</span>
      {steps && (
        <StepButton
          direction={1}
          disabled={!steps.canStepForward}
          onStep={steps.onStep}
        />
      )}
    </div>
  );
}

/**
 * One of the two arrows beside a subtitle: back to the start of the previous
 * line, or on to the start of the next one.
 *
 * Sized in `em` so it stays in proportion to whatever the subtitle is set to —
 * a fixed 16px chevron is a smudge next to 60px text and a slab next to 14px.
 *
 * The press is stopped before it reaches the block, which would otherwise
 * treat it as the start of a drag. Nothing goes wrong if it does — the drag
 * only begins past a threshold — but a subtitle that shifts under the pointer
 * while you are trying to step through lines is its own kind of wrong.
 */
function StepButton({
  direction,
  disabled,
  onStep,
}: {
  direction: -1 | 1;
  disabled: boolean;
  onStep: (delta: number) => void;
}) {
  const label = direction < 0 ? "Previous line" : "Next line";
  const Icon = direction < 0 ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onStep(direction)}
      className={cn(
        "shrink-0 cursor-pointer rounded-full p-[0.1em] leading-none transition",
        "opacity-45 hover:bg-white/25 hover:opacity-100",
        "disabled:pointer-events-none disabled:opacity-15",
      )}
    >
      <Icon className="size-[0.9em]" strokeWidth={2.5} />
    </button>
  );
}

function WordButton({
  text,
  token,
  isSelected,
  onSelect,
}: {
  text: string;
  token: Token;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={token.reading || undefined}
      className={cn(
        "rounded-[3px] transition-colors",
        // No horizontal padding: Japanese has no word gaps, and adding any
        // would visibly re-space the sentence.
        "cursor-pointer hover:bg-white/25",
        isSelected && "bg-primary/50 underline decoration-white/80 underline-offset-4",
      )}
    >
      {text}
    </button>
  );
}

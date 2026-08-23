import type { Segment, Token } from "@/lib/types";

/** A run of a line: either one token, or the text between two of them. */
export interface TokenPiece {
  text: string;
  token: Token | null;
}

/**
 * Splits a segment into renderable pieces.
 *
 * Tokens carry character offsets into `text`, but the gaps between them
 * (whitespace, unhandled punctuation) still have to render, so a line is
 * rebuilt as an alternating sequence of tokens and literal spans.
 *
 * Offsets are in characters, so the text is spread into an array first —
 * `String.prototype.slice` counts UTF-16 code units and would corrupt any
 * character outside the BMP.
 *
 * A segment with no tokens — every non-Japanese transcript, and any line the
 * tokenizer could not read — comes back as a single untokenized piece, which
 * renders as plain text.
 */
export function splitIntoPieces(segment: Segment): TokenPiece[] {
  if (segment.tokens.length === 0) {
    return [{ text: segment.text, token: null }];
  }

  const chars = [...segment.text];
  const pieces: TokenPiece[] = [];
  let cursor = 0;

  for (const token of segment.tokens) {
    // Defensive: a malformed offset should drop one token, not the line.
    if (token.start < cursor || token.end > chars.length || token.start >= token.end) {
      continue;
    }
    if (token.start > cursor) {
      pieces.push({ text: chars.slice(cursor, token.start).join(""), token: null });
    }
    pieces.push({ text: chars.slice(token.start, token.end).join(""), token });
    cursor = token.end;
  }

  if (cursor < chars.length) {
    pieces.push({ text: chars.slice(cursor).join(""), token: null });
  }
  return pieces;
}

/** Whether `token` is the one currently selected in `segment`. */
export function isSelectedToken(
  token: Token,
  segment: Segment,
  selected: { token: Token; segment: Segment } | null,
): boolean {
  if (!selected || selected.segment.id !== segment.id) return false;
  // Position *and* surface: a line can contain the same word twice, and only
  // the one that was clicked should light up.
  return selected.token.start === token.start && selected.token.surface === token.surface;
}

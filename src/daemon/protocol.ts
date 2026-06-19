// Tiny JSON-line protocol over the daemon's Unix socket.
//
// Request:  a single JSON object terminated by '\n'.
// The daemon may emit zero or more *progress* lines before the final
// response, to stream latency information to the caller:
//   {"progress": "starting rust-analyzer…"}
// Response: a single JSON object terminated by '\n'.
//
// Kept minimal and stable. New methods are additive; never reuse a method
// name for a different shape. Positions are 0-indexed LSP positions on the
// wire; the CLI layer converts to 1-indexed for human display.

export interface DaemonRequest {
  /** Method name, e.g. "defs", "refs", "open". */
  m: string;
  /** Positional args, method-specific. */
  a?: unknown[];
}

export interface DaemonResponse {
  ok: boolean;
  /** Result payload on success. */
  r?: unknown;
  /** Error message on failure. */
  e?: string;
}

/** Interleaved progress note, sent before the final DaemonResponse. */
export interface ProgressNote {
  progress: string;
}

/** A parsed line from the socket: either a progress note or the final reply. */
export type WireLine = ProgressNote | DaemonResponse;

export function isProgressNote(v: unknown): v is ProgressNote {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ProgressNote).progress === "string" &&
    !("ok" in v)
  );
}

/** Parse one JSON object from a line (tolerant of trailing whitespace). */
export function parseLine(line: string): WireLine | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as WireLine;
  } catch {
    return null;
  }
}
